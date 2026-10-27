import { ObjectStore } from "../../../storage/objectStore";
import { objectStore } from "../../../storage/r2Storage";
import { notificationsService } from "../../notifications/service/notifications.service";
import {
  NON_STORAGE_JOB_KINDS,
  OUTBOX_LEASE_MS,
  OutboxJob,
  parseOutboxJob,
  retryDelayMs,
  STORAGE_JOB_KINDS,
} from "../outbox.jobs";
import { outboxRepository } from "../repository/outbox.repository";

// The outbox drain (the worker's outbox.drain job, every minute). Runs due jobs — against R2, or the
// notification senders — and retries failures with backoff, forever: a purge already stopped the
// billing, and these jobs are what make the bytes actually go (the privacy and delete-account pages
// promise that). Notifications give up on their own after their retry window.

export interface OutboxServiceDeps {
  now: () => Date;
  store: ObjectStore | null;
  /** Sends a notification's pending channels; throws while one is worth retrying. */
  notifications: { deliver(notificationId: string): Promise<void> };
}

/** One drain run stops claiming new work after this long, leaving the rest for the next minute. */
const DRAIN_BUDGET_MS = 40_000;
const CLAIM_BATCH = 25;
/** Pages of a prefix one run of a DELETE_PREFIX job works through before yielding. */
const PREFIX_PAGES_PER_RUN = 20;

type Outcome = "done" | "again";

const runStorageJob = async (store: ObjectStore, job: Exclude<OutboxJob, { kind: "SEND_NOTIFICATION" }>): Promise<Outcome> => {
  switch (job.kind) {
    case "DELETE_OBJECTS":
      await store.deleteObjects(job.payload.keys);
      return "done";

    case "CLEANUP_UPLOAD":
      // Abort first: once aborted, no late part can complete into an object after the delete.
      if (job.payload.uploadId) await store.abortMultipartUpload(job.payload.key, job.payload.uploadId);
      await store.deleteObjects([job.payload.key, job.payload.thumbKey]);
      return "done";

    case "DELETE_PREFIX": {
      const { prefix } = job.payload;
      let budget = PREFIX_PAGES_PER_RUN;
      // Unfinished multipart uploads first, for the same reason as above.
      let next: string | null = null;
      do {
        if (budget-- <= 0) return "again";
        const page = await store.listMultipartUploads(prefix, next);
        for (const upload of page.items) await store.abortMultipartUpload(upload.key, upload.uploadId);
        next = page.next;
      } while (next);
      // Then the objects: delete a page, list again from the start (deleted keys are gone).
      for (;;) {
        if (budget-- <= 0) return "again";
        const page = await store.listObjects(prefix);
        if (page.items.length === 0) return "done";
        await store.deleteObjects(page.items.map((object) => object.key));
      }
    }
  }
};

export class OutboxService {
  constructor(private readonly deps: OutboxServiceDeps) {}

  private async runJob(job: OutboxJob): Promise<Outcome> {
    if (job.kind === "SEND_NOTIFICATION") {
      await this.deps.notifications.deliver(job.payload.notificationId);
      return "done";
    }
    // Never claimed without a store (see drain), so this is a bug if it throws.
    if (!this.deps.store) throw new Error("storage not configured");
    return runStorageJob(this.deps.store, job);
  }

  /** Job: run every due outbox job. Returns a one-line summary. */
  async drain(): Promise<string> {
    // Without storage, the storage jobs wait; notifications still go.
    const kinds = this.deps.store ? null : NON_STORAGE_JOB_KINDS;
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    let done = 0;
    let continuing = 0;
    let failed = 0;
    while (Date.now() < deadline) {
      const now = this.deps.now();
      const jobs = await outboxRepository.claim(now, new Date(now.getTime() + OUTBOX_LEASE_MS), CLAIM_BATCH, kinds);
      if (jobs.length === 0) break;
      for (const claimed of jobs) {
        try {
          const outcome = await this.runJob(parseOutboxJob(claimed.kind, claimed.payload));
          if (outcome === "done") {
            await outboxRepository.finish(claimed.id);
            done += 1;
          } else {
            await outboxRepository.continueAt(claimed.id, this.deps.now());
            continuing += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const retryAt = new Date(this.deps.now().getTime() + retryDelayMs(claimed.attempts));
          await outboxRepository.retryAt(claimed.id, retryAt, message);
          failed += 1;
          console.error(`[outbox] job ${claimed.id} (${claimed.kind}) failed on attempt ${claimed.attempts}: ${message}`);
        }
      }
    }

    const backlog = await outboxRepository.backlog();
    const failing = backlog.failing > 0 ? `, ${backlog.failing} failing` : "";
    const summary = `${done} done, ${continuing} continuing, ${failed} failed; ${backlog.count} queued${failing}`;
    if (this.deps.store) return summary;
    const waiting = await outboxRepository.countOfKinds(STORAGE_JOB_KINDS);
    return waiting > 0 ? `storage not configured: ${waiting} storage job(s) waiting; ${summary}` : summary;
  }
}

export const outboxService = new OutboxService({ now: () => new Date(), store: objectStore, notifications: notificationsService });
