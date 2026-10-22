import { BadRequestError } from "../../common/errors/AppError";
import { UploadedPart } from "../../storage/objectStore";
import {
  MAX_PARTS,
  PART_SIZE_BYTES,
  PART_URLS_PER_REQUEST,
  SINGLE_PUT_MAX_BYTES,
  UPLOAD_IDLE_EXPIRY_HOURS,
  UPLOAD_MAX_AGE_HOURS,
  UPLOAD_URL_TTL_SECONDS,
} from "./files.policy";

// Pure rules for uploads and downloads — part sizing, object keys, media types, URL lifetimes. No
// database, no network, no clock of their own: check:storage pins them.

const MiB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------- object keys
//
// Keys never contain file names (renames need no copy, and the bucket listing reveals nothing).
// The owner's id comes first, so one prefix holds everything an account stored.

export const objectKeyFor = (userId: string, blobId: string): string => `u/${userId}/${blobId}`;
export const thumbKeyFor = (userId: string, blobId: string): string => `t/${userId}/${blobId}.webp`;
/** Every prefix an account's objects live under. */
export const accountPrefixes = (userId: string): string[] => [`u/${userId}/`, `t/${userId}/`];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_KEY = new RegExp(`^u/(${UUID})/(${UUID})$`);
const THUMB_KEY = new RegExp(`^t/(${UUID})/(${UUID})\\.webp$`);

/** What a key in the bucket is, or null for a key BenchBox never issues. */
export const parseObjectKey = (key: string): { kind: "object" | "thumb"; userId: string; blobId: string } | null => {
  const object = OBJECT_KEY.exec(key);
  if (object) return { kind: "object", userId: object[1]!, blobId: object[2]! };
  const thumb = THUMB_KEY.exec(key);
  if (thumb) return { kind: "thumb", userId: thumb[1]!, blobId: thumb[2]! };
  return null;
};

// ---------------------------------------------------------------- upload plan

export interface UploadPlan {
  mode: "single" | "multipart";
  partSize: number | null;
  partCount: number | null;
}

/**
 * How a file of `size` bytes goes up: one PUT up to SINGLE_PUT_MAX_BYTES, otherwise parts of
 * PART_SIZE_BYTES — or of a larger whole number of MiB when that would take more than MAX_PARTS.
 */
export const planUpload = (size: number): UploadPlan => {
  if (size <= SINGLE_PUT_MAX_BYTES) return { mode: "single", partSize: null, partCount: null };
  const partSize = Math.max(PART_SIZE_BYTES, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  return { mode: "multipart", partSize, partCount: Math.ceil(size / partSize) };
};

/** The exact size part `partNumber` (1-based) must have: `partSize`, except the last. */
export const partSizeOf = (partNumber: number, partSize: number, partCount: number, totalSize: number): number =>
  partNumber < partCount ? partSize : totalSize - partSize * (partCount - 1);

/**
 * Which of parts 1..partCount R2 holds at exactly the right size. A part of the wrong size counts as
 * missing — uploading the same part number again replaces it. `complete` is the list to hand to
 * CompleteMultipartUpload, or null while anything is missing.
 */
export const checkParts = (
  uploaded: readonly UploadedPart[],
  plan: { partSize: number; partCount: number; totalSize: number }
): { done: number[]; missing: number[]; complete: UploadedPart[] | null } => {
  const byNumber = new Map(uploaded.map((part) => [part.partNumber, part]));
  const done: number[] = [];
  const missing: number[] = [];
  const complete: UploadedPart[] = [];
  for (let n = 1; n <= plan.partCount; n += 1) {
    const part = byNumber.get(n);
    if (part && part.size === partSizeOf(n, plan.partSize, plan.partCount, plan.totalSize)) {
      done.push(n);
      complete.push(part);
    } else {
      missing.push(n);
    }
  }
  return { done, missing, complete: missing.length === 0 ? complete : null };
};

/** The body of POST /uploads/:id/parts: 1–50 distinct part numbers within the upload. */
export const parsePartNumbers = (raw: unknown, partCount: number): number[] => {
  const invalid = (): BadRequestError =>
    new BadRequestError(
      `"partNumbers" must be 1 to ${PART_URLS_PER_REQUEST} distinct whole numbers from 1 to ${partCount}`
    );
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PART_URLS_PER_REQUEST) throw invalid();
  const numbers = new Set<number>();
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > partCount || numbers.has(value)) {
      throw invalid();
    }
    numbers.add(value);
  }
  return [...numbers].sort((a, b) => a - b);
};

// ---------------------------------------------------------------- lifetimes

/** An upload's expiry after activity at `now`: idle expiry, capped by the hard maximum age. */
export const uploadExpiry = (createdAt: Date, now: Date): Date =>
  new Date(Math.min(createdAt.getTime() + UPLOAD_MAX_AGE_HOURS * HOUR_MS, now.getTime() + UPLOAD_IDLE_EXPIRY_HOURS * HOUR_MS));

/** Lifetime of an upload URL issued at `now`: never past the upload's own expiry. */
export const uploadUrlTtlSeconds = (expiresAt: Date, now: Date): number =>
  Math.max(1, Math.min(UPLOAD_URL_TTL_SECONDS, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)));

// ---------------------------------------------------------------- media types and names

export const DEFAULT_MIME_TYPE = "application/octet-stream";

// RFC 6838's restricted-name characters, type/subtype only.
const MIME_ESSENCE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The app's declared media type, reduced to "type/subtype" in lower case (parameters such as
 * "; charset=utf-8" are dropped). Absent → application/octet-stream; malformed → INVALID_MIME_TYPE.
 */
export const normalizeMimeType = (raw: unknown): string => {
  if (raw === undefined || raw === null) return DEFAULT_MIME_TYPE;
  if (typeof raw !== "string") throw new BadRequestError('"mimeType" must be a string', "INVALID_MIME_TYPE");
  const essence = (raw.split(";")[0] ?? "").trim().toLowerCase();
  if (essence === "") return DEFAULT_MIME_TYPE;
  if (!MIME_ESSENCE.test(essence)) {
    throw new BadRequestError('"mimeType" must be a media type such as "image/jpeg"', "INVALID_MIME_TYPE");
  }
  return essence;
};

/**
 * Content-Disposition for a download: the real name (object keys don't carry it), as an ASCII
 * fallback plus the exact UTF-8 name (RFC 6266 / RFC 5987), so every client gets a usable name.
 */
export const attachmentDisposition = (name: string): string => {
  const ascii =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // drop the accents NFKD split off: "Résumé" → "Resume"
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "download";
  const exact = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
};

// ---------------------------------------------------------------- storage allowance

/**
 * Whether an upload fits the account's allowance: what it stores, plus what its other unfinished
 * uploads have reserved, plus this file, minus the file it will replace (if any). `allowance` null
 * means no limit.
 */
export const fitsAllowance = (input: {
  storedBytes: bigint;
  reservedBytes: bigint;
  size: bigint;
  replacedBytes: bigint;
  allowance: bigint | null;
}): boolean =>
  input.allowance === null || input.storedBytes + input.reservedBytes + input.size - input.replacedBytes <= input.allowance;
