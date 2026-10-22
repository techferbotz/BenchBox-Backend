import { UploadState } from "@prisma/client";
import { ObjectStore } from "../../../storage/objectStore";
import { objectStore } from "../../../storage/r2Storage";
import { userRepository } from "../../account/repository/user.repository";
import { meteringRepository } from "../../metering/repository/metering.repository";
import { deleteObjectsJobs, OutboxJobInput } from "../../outbox/outbox.jobs";
import { outboxRepository } from "../../outbox/repository/outbox.repository";
import { accountPrefixes, parseObjectKey, thumbKeyFor } from "../files.rules";
import { blobRepository } from "../repository/blob.repository";
import { uploadRepository } from "../repository/upload.repository";

// The storage.reconcile job (daily; docs/BACKEND_PLAN.md §5.3). REPORT-FIRST: it fixes only what is
// provably garbage — objects of purged blobs and ended uploads, a deleted account's leftovers,
// multipart uploads nothing is waiting for — and reports everything else for a human:
//   - accounting drift: User.storedBytes vs its unpurged blobs vs the newest StorageEvent;
//   - broken links: a live file without content, or content no live file points at;
//   - unknown objects: keys BrimBox never issued, or owned by no account;
//   - MISSING objects: a live blob whose object isn't in the bucket. That is data loss.

export interface ReconcileServiceDeps {
  now: () => Date;
  store: ObjectStore | null;
}

export interface BucketFindings {
  accounts: number;
  ok: number;
  /** Objects (and deleted accounts' prefixes) queued for deletion. */
  queued: number;
  /** Multipart uploads nothing was waiting for, aborted. */
  aborted: number;
  unknown: string[];
  missing: string[];
  failures: string[];
}

export interface ReconcileReport {
  accounts: number;
  /** Accounts whose stored bytes, live blobs and event log disagree. */
  drifting: string[];
  orphanBlobs: number;
  filesWithoutContent: number;
  /** Null when storage isn't configured. */
  bucket: BucketFindings | null;
}

const SAMPLE = 5;

const sample = (items: string[]): string => (items.length ? ` [${items.slice(0, SAMPLE).join(", ")}]` : "");

const listAll = async <T>(page: (next: string | null) => Promise<{ items: T[]; next: string | null }>): Promise<T[]> => {
  const all: T[] = [];
  let next: string | null = null;
  do {
    const result = await page(next);
    all.push(...result.items);
    next = result.next;
  } while (next);
  return all;
};

export class ReconcileService {
  constructor(private readonly deps: ReconcileServiceDeps) {}

  /** Job: inspect, fix the provable garbage, and summarise — "ALERT …" when a human must look. */
  async run(now: Date): Promise<string> {
    const report = await this.inspect(now);
    const parts = [
      `accounting: ${report.accounts} account(s), ${report.drifting.length} drifting${sample(report.drifting)}`,
      `links: ${report.orphanBlobs} orphan blob(s), ${report.filesWithoutContent} file(s) without content`,
    ];
    const bucket = report.bucket;
    parts.push(
      bucket
        ? `bucket: ${bucket.accounts} account(s), ${bucket.ok} object(s) ok, ${bucket.queued} queued for deletion, ` +
            `${bucket.aborted} stray upload(s) aborted, ${bucket.unknown.length} unknown${sample(bucket.unknown)}, ` +
            `${bucket.missing.length} MISSING${sample(bucket.missing)}`
        : "bucket: not checked (storage not configured)"
    );
    const summary = parts.join("; ");
    if (bucket && bucket.failures.length > 0) {
      throw new Error(`reconcile failed for ${bucket.failures.length} account(s):${sample(bucket.failures)} — ${summary}`);
    }
    const alarm =
      report.drifting.length > 0 ||
      report.orphanBlobs > 0 ||
      report.filesWithoutContent > 0 ||
      (bucket !== null && (bucket.unknown.length > 0 || bucket.missing.length > 0));
    if (alarm) console.error(`[reconcile] ALERT ${summary}`);
    return alarm ? `ALERT ${summary}` : summary;
  }

  async inspect(now: Date): Promise<ReconcileReport> {
    const accounting = await meteringRepository.accounting();
    const links = await meteringRepository.brokenLinks();
    return {
      accounts: accounting.length,
      drifting: accounting
        .filter((row) => row.storedBytes !== row.blobBytes || (row.lastTotal ?? 0n) !== row.storedBytes)
        .map((row) => row.userId),
      orphanBlobs: links.orphanBlobs,
      filesWithoutContent: links.filesWithoutContent,
      bucket: this.deps.store ? await this.checkBucket(this.deps.store, now) : null,
    };
  }

  /** Every account with objects in the bucket or live blobs in the database, one at a time. */
  private async checkBucket(store: ObjectStore, now: Date): Promise<BucketFindings> {
    const found: BucketFindings = { accounts: 0, ok: 0, queued: 0, aborted: 0, unknown: [], missing: [], failures: [] };
    const owners = new Set<string>();
    for (const top of ["u/", "t/"]) {
      for (const prefix of await listAll((next) => store.listPrefixes(top, next))) {
        const owner = /^[ut]\/([0-9a-f-]{36})\/$/.exec(prefix)?.[1];
        if (owner) owners.add(owner);
        else found.unknown.push(prefix);
      }
    }
    // Accounts whose objects are ALL missing have no prefix in the bucket to list.
    for (let after: string | null = null; ; ) {
      const page = await blobRepository.ownersWithLiveBlobs(after, 500);
      page.forEach((owner) => owners.add(owner));
      if (page.length < 500) break;
      after = page[page.length - 1] ?? null;
    }
    for (const owner of owners) {
      try {
        await this.checkAccount(store, owner, now, found);
        found.accounts += 1;
      } catch (err) {
        found.failures.push(`${owner}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return found;
  }

  private async checkAccount(store: ObjectStore, userId: string, now: Date, found: BucketFindings): Promise<void> {
    const status = await userRepository.findStatus(userId);
    if (!status) {
      // Objects of an account this database never had (another environment's bucket?): report only.
      found.unknown.push(`${accountPrefixes(userId)[0]}… (no such account)`);
      return;
    }
    if (status.deletedAt) {
      // A deleted account keeps nothing: sweep its prefixes again (the deletion already queued this).
      const jobs: OutboxJobInput[] = accountPrefixes(userId).map((prefix) => ({ kind: "DELETE_PREFIX", payload: { prefix }, runAfter: now }));
      await outboxRepository.enqueue(jobs);
      found.queued += jobs.length;
      return;
    }

    const [objects, uploads, blobs, sessions] = await Promise.all([
      Promise.all(accountPrefixes(userId).map((prefix) => listAll((next) => store.listObjects(prefix, next)))).then((pages) => pages.flat()),
      listAll((next) => store.listMultipartUploads(accountPrefixes(userId)[0]!, next)),
      blobRepository.allForOwner(userId),
      uploadRepository.allForOwner(userId),
    ]);

    // What may be in the bucket: live content, and uploads still in progress.
    const keep = new Set<string>();
    for (const blob of blobs) {
      if (blob.purgedAt) continue;
      keep.add(blob.objectKey);
      if (blob.thumbKey) keep.add(blob.thumbKey);
    }
    for (const session of sessions) {
      if (session.state !== UploadState.PENDING) continue;
      keep.add(session.objectKey);
      if (session.thumbSize !== null) keep.add(thumbKeyFor(userId, session.id));
    }
    // Ids this account's keys may carry: anything else under its prefix was never issued.
    const knownIds = new Set([...blobs.map((blob) => blob.id), ...sessions.map((session) => session.id)]);

    const present = new Set<string>();
    const garbage: string[] = [];
    for (const object of objects) {
      present.add(object.key);
      if (keep.has(object.key)) {
        found.ok += 1;
        continue;
      }
      const parsed = parseObjectKey(object.key);
      if (parsed && parsed.userId === userId && knownIds.has(parsed.blobId)) garbage.push(object.key);
      else found.unknown.push(object.key);
    }
    if (garbage.length > 0) {
      await outboxRepository.enqueue(deleteObjectsJobs(garbage, now));
      found.queued += garbage.length;
    }

    for (const blob of blobs) {
      if (!blob.purgedAt && !present.has(blob.objectKey)) found.missing.push(blob.objectKey);
    }

    // Multipart uploads nothing is waiting for (a pending session holds exactly one) — aborted here
    // rather than through the outbox, whose cleanup would also delete the key, which may be live.
    const waiting = new Set(
      sessions.filter((s) => s.state === UploadState.PENDING && s.r2UploadId).map((s) => `${s.objectKey}\n${s.r2UploadId}`)
    );
    for (const upload of uploads) {
      if (waiting.has(`${upload.key}\n${upload.uploadId}`)) continue;
      await store.abortMultipartUpload(upload.key, upload.uploadId);
      found.aborted += 1;
    }
  }
}

export const reconcileService = new ReconcileService({ now: () => new Date(), store: objectStore });
