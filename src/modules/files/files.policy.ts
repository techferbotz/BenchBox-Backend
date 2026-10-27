// File-storage policy numbers (docs/BACKEND_PLAN.md §5.1–5.3). The ones the app needs are served in
// GET /config → limits, imported from here, never retyped.

const MiB = 1024 * 1024;

/**
 * Largest file an upload may declare: 10 GB (1 GB = 10⁹ bytes, as phones show sizes). The server
 * obeys the resolved remote config (limits.maxFileSizeBytes), which defaults to this, so an env
 * override changes the limit and what the app is told in one move.
 */
export const MAX_FILE_SIZE_BYTES = 10_000_000_000;

/** R2's own ceiling for one object (~4.995 TiB, rounded down); no override goes past it. */
export const STORAGE_MAX_OBJECT_BYTES = 5_000_000_000_000;

/** Up to this size a file goes up in ONE presigned PUT; anything larger, in parts. */
export const SINGLE_PUT_MAX_BYTES = 16 * MiB;

/** Multipart part size. R2 needs every part but the last to be the same size, and ≥ 5 MiB. */
export const PART_SIZE_BYTES = 8 * MiB;

/** R2's limit on the parts of one upload; very large files get bigger parts to stay under it. */
export const MAX_PARTS = 10_000;

/** Part URLs per request (POST /uploads/:id/parts). */
export const PART_URLS_PER_REQUEST = 50;

/** Lifetime of upload URLs (whole file, parts, thumbnail). */
export const UPLOAD_URL_TTL_SECONDS = 60 * 60;

/** An upload nobody has touched for this long expires, and its partial bytes are deleted. */
export const UPLOAD_IDLE_EXPIRY_HOURS = 24;

/**
 * However active, an upload expires this long after it started — before R2's own lifecycle rule
 * drops unfinished multipart uploads at 7 days, so the database and the bucket never disagree.
 */
export const UPLOAD_MAX_AGE_HOURS = 6 * 24;

/** Unfinished uploads one account may have at a time. */
export const MAX_PENDING_UPLOADS = 50;

/** The app's thumbnail: a ≤ 512 px WebP fits easily. Thumbnails are not billed. */
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

/** Lifetime of a download URL. Ranges work, so a download can resume within it. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Lifetime of a thumbnail URL (the 302 from GET /files/:id/thumbnail). */
export const THUMBNAIL_URL_TTL_SECONDS = 60 * 60;

/**
 * Cleanup of an ended upload waits this long, so a PUT that started on a still-valid URL has
 * finished before its object is deleted (a presigned URL can't be revoked).
 */
export const UPLOAD_CLEANUP_DELAY_SECONDS = UPLOAD_URL_TTL_SECONDS + 15 * 60;

/**
 * Public promise (the delete-account page quotes it): after an account is deleted, its files are
 * removed from object storage within this many days. Enforced by the outbox — the deletion queues
 * a sweep of the account's whole prefix, retried until it succeeds, and a second sweep once every
 * URL issued before the deletion has expired — with the daily storage.reconcile job as backstop.
 */
export const DELETION_STORAGE_PURGE_DAYS = 7;
