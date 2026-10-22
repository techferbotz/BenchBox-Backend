import { UPLOAD_CLEANUP_DELAY_SECONDS } from "../files/files.policy";
import { accountPrefixes } from "../files/files.rules";

// The outbox's job kinds: work that must happen after a transaction commits and must not be lost —
// today, removing bytes from R2. A job is queued in the same transaction as the change that needs
// it and retried until it succeeds; every kind is idempotent, so running one twice is harmless.
// Pure: no database, no network (check:storage pins the builders and the backoff).

export type OutboxJob =
  /** Delete these objects (≤ 1000): purged files and their thumbnails. */
  | { kind: "DELETE_OBJECTS"; payload: { keys: string[] } }
  /** An upload that ended without a file: abort its multipart upload, then delete what landed. */
  | { kind: "CLEANUP_UPLOAD"; payload: { key: string; thumbKey: string; uploadId: string | null } }
  /** Everything under a prefix — a deleted account's objects and unfinished uploads. */
  | { kind: "DELETE_PREFIX"; payload: { prefix: string } };

/** A job to queue: not before `runAfter`. */
export type OutboxJobInput = OutboxJob & { runAfter: Date };

const MAX_KEYS_PER_DELETE = 1000;

/** Delete jobs for `keys`, at most 1000 keys each (R2's DeleteObjects limit). */
export const deleteObjectsJobs = (keys: readonly string[], runAfter: Date): OutboxJobInput[] => {
  const jobs: OutboxJobInput[] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_DELETE) {
    jobs.push({ kind: "DELETE_OBJECTS", payload: { keys: keys.slice(i, i + MAX_KEYS_PER_DELETE) }, runAfter });
  }
  return jobs;
};

/**
 * Cleanup for an upload that ended without becoming a file. `delayed` waits out the upload URLs
 * already handed to the app (they can't be revoked), so a PUT still in flight lands BEFORE the
 * delete instead of after it. An expired upload needs no wait: its last URL expired long ago.
 */
export const uploadCleanupJob = (
  session: { objectKey: string; thumbKey: string; r2UploadId: string | null },
  now: Date,
  delayed: boolean
): OutboxJobInput => ({
  kind: "CLEANUP_UPLOAD",
  payload: { key: session.objectKey, thumbKey: session.thumbKey, uploadId: session.r2UploadId },
  runAfter: delayed ? new Date(now.getTime() + UPLOAD_CLEANUP_DELAY_SECONDS * 1000) : now,
});

/**
 * A deleted account's storage: every prefix it owns swept now, and swept again once every URL
 * issued before the deletion has expired, so nothing uploaded in that window survives.
 */
export const accountCleanupJobs = (userId: string, now: Date): OutboxJobInput[] =>
  [now, new Date(now.getTime() + UPLOAD_CLEANUP_DELAY_SECONDS * 1000)].flatMap((runAfter) =>
    accountPrefixes(userId).map((prefix): OutboxJobInput => ({ kind: "DELETE_PREFIX", payload: { prefix }, runAfter }))
  );

/** How long a job claimed by the drain stays invisible to other drains before it is retried. */
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

/** Retry delay after the `attempts`-th failure: 1, 2, 4 … minutes, capped at one hour. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(60, 2 ** Math.max(0, Math.min(attempts, 7) - 1)) * 60 * 1000;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** A stored job, checked. A row that doesn't parse is a bug: it fails (and stays visible). */
export const parseOutboxJob = (kind: string, payload: unknown): OutboxJob => {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  if (kind === "DELETE_OBJECTS" && isStringArray(p.keys)) return { kind, payload: { keys: p.keys } };
  if (kind === "CLEANUP_UPLOAD" && typeof p.key === "string" && typeof p.thumbKey === "string") {
    const uploadId = typeof p.uploadId === "string" ? p.uploadId : null;
    return { kind, payload: { key: p.key, thumbKey: p.thumbKey, uploadId } };
  }
  if (kind === "DELETE_PREFIX" && typeof p.prefix === "string" && /^[ut]\/[0-9a-f-]{36}\/$/.test(p.prefix)) {
    return { kind, payload: { prefix: p.prefix } };
  }
  throw new Error(`Unreadable outbox job of kind ${kind}`);
};
