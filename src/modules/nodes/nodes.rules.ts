import { BadRequestError } from "../../common/errors/AppError";
import { MAX_NAME_BYTES } from "./nodes.policy";

// Pure rules for the file tree — names, cursors, limits. No database, no clock: check:tree pins them.

export type NodeKindName = "FOLDER" | "FILE";

export interface NormalizedName {
  name: string;
  nameKey: string;
}

const FORBIDDEN_NAME_CHARS = /[/\\\u0000-\u001f\u007f]/;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * The key two names collide on: NFC, then lower-case. "Photos", "PHOTOS" and "Photos" spelt with a
 * decomposed character are all one key, so a folder can't hold two of them.
 */
export const nameKeyOf = (name: string): string => name.normalize("NFC").toLowerCase();

/** Validate a user-supplied name and normalise it (NFC, trimmed). Throws INVALID_NAME. */
export const normalizeName = (raw: unknown): NormalizedName => {
  if (typeof raw !== "string") {
    throw new BadRequestError('"name" is required and must be a string', "INVALID_NAME");
  }
  const name = raw.normalize("NFC").trim();
  if (name.length === 0) throw new BadRequestError("A name can't be empty", "INVALID_NAME");
  if (utf8Bytes(name) > MAX_NAME_BYTES) {
    throw new BadRequestError(`A name can be at most ${MAX_NAME_BYTES} bytes long`, "INVALID_NAME");
  }
  if (name === "." || name === "..") {
    throw new BadRequestError('A name can\'t be "." or ".."', "INVALID_NAME");
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    throw new BadRequestError("A name can't contain / or \\ or control characters", "INVALID_NAME");
  }
  return { name, nameKey: nameKeyOf(name) };
};

// A file keeps its extension last when numbered ("photo (1).jpg"); a folder, or a dotfile like
// ".env", is numbered at the end.
const splitForNumbering = (name: string, kind: NodeKindName): [string, string] => {
  const dot = kind === "FILE" ? name.lastIndexOf(".") : -1;
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
};

/** The prefix every numbered variant of `name` starts with — what to query the taken keys by. */
export const numberingPrefixKey = (name: string, kind: NodeKindName): string =>
  nameKeyOf(splitForNumbering(name, kind)[0]);

/**
 * `name` if it's free, otherwise the first free "name (n)" given the sibling keys already taken.
 * The base is shortened if needed so the result still fits the length limit.
 */
export const availableName = (name: string, kind: NodeKindName, taken: ReadonlySet<string>): string => {
  if (!taken.has(nameKeyOf(name))) return name;
  const [base, ext] = splitForNumbering(name, kind);
  for (let n = 1; ; n += 1) {
    const suffix = ` (${n})${ext}`;
    let trimmed = base;
    while (trimmed.length > 0 && utf8Bytes(trimmed + suffix) > MAX_NAME_BYTES) {
      trimmed = Array.from(trimmed).slice(0, -1).join("");
    }
    const candidate = trimmed + suffix;
    if (!taken.has(nameKeyOf(candidate))) return candidate;
  }
};

/**
 * Make text match literally inside LIKE. Prisma's `contains` / `startsWith` do NOT escape `%` and
 * `_` (check:tree-db caught "50%" matching "500 files"); Postgres's default LIKE escape is `\`.
 */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// ---------------------------------------------------------------- limits

export const parseLimit = (raw: unknown, fallback: number, max: number): number => {
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(`"limit" must be a whole number from 1 to ${max}`);
  }
  return value;
};

// ---------------------------------------------------------------- cursors
//
// Opaque to the app: base64url JSON of the last row's sort key. Not signed — a cursor only says where
// the caller's OWN listing resumes, so editing one can't reach anyone else's data.

const invalidCursor = (): BadRequestError =>
  new BadRequestError("This cursor is not valid; start again without one", "INVALID_CURSOR");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encode = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decode = (raw: unknown): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) throw invalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidCursor();
  return value as Record<string, unknown>;
};

/** The same opaque format, for other listings (statements). */
export { encode as encodeCursor, decode as decodeCursor, invalidCursor };

/** Children are listed folders first, each kind by name. The cursor says which kind it's in. */
export interface ChildrenCursor {
  phase: "FOLDER" | "FILE";
  after: { nameKey: string; id: string } | null;
}

export const encodeChildrenCursor = (c: ChildrenCursor): string =>
  encode(c.after ? { p: c.phase, k: c.after.nameKey, i: c.after.id } : { p: c.phase });

export const decodeChildrenCursor = (raw: unknown): ChildrenCursor | undefined => {
  const v = decode(raw);
  if (!v) return undefined;
  if (v.p !== "FOLDER" && v.p !== "FILE") throw invalidCursor();
  if (v.k === undefined && v.i === undefined) return { phase: v.p, after: null };
  if (typeof v.k !== "string" || typeof v.i !== "string" || !UUID.test(v.i)) throw invalidCursor();
  return { phase: v.p, after: { nameKey: v.k, id: v.i } };
};

/** Search results by name. */
export interface NameCursor {
  nameKey: string;
  id: string;
}

export const encodeNameCursor = (c: NameCursor): string => encode({ k: c.nameKey, i: c.id });

export const decodeNameCursor = (raw: unknown): NameCursor | undefined => {
  const v = decode(raw);
  if (!v) return undefined;
  if (typeof v.k !== "string" || typeof v.i !== "string" || !UUID.test(v.i)) throw invalidCursor();
  return { nameKey: v.k, id: v.i };
};

/** The trash, most recently trashed first. */
export interface TrashCursor {
  trashedAt: Date;
  id: string;
}

export const encodeTrashCursor = (c: TrashCursor): string =>
  encode({ t: c.trashedAt.toISOString(), i: c.id });

export const decodeTrashCursor = (raw: unknown): TrashCursor | undefined => {
  const v = decode(raw);
  if (!v) return undefined;
  const t = typeof v.t === "string" ? new Date(v.t) : null;
  if (!t || Number.isNaN(t.getTime()) || typeof v.i !== "string" || !UUID.test(v.i)) throw invalidCursor();
  return { trashedAt: t, id: v.i };
};

/**
 * A position in the change feed, which runs in (syncSeq, id) order: everything up to and including
 * (seq, id) has been delivered. `floor` is the account's resync floor when the cursor was issued —
 * how the feed tells "compaction happened since this device last synced" (resync) from "a full sync
 * is still walking through old rows" (fine).
 */
export interface SyncCursor {
  seq: bigint;
  id: string;
  floor: bigint;
}

export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const DIGITS = /^\d{1,19}$/;

export const encodeSyncCursor = (c: SyncCursor): string =>
  encode({ s: c.seq.toString(), i: c.id, f: c.floor.toString() });

export const decodeSyncCursor = (raw: unknown): SyncCursor | undefined => {
  const v = decode(raw);
  if (!v) return undefined;
  if (
    typeof v.s !== "string" || !DIGITS.test(v.s) ||
    typeof v.i !== "string" || !UUID.test(v.i) ||
    typeof v.f !== "string" || !DIGITS.test(v.f)
  ) {
    throw invalidCursor();
  }
  return { seq: BigInt(v.s), id: v.i.toLowerCase(), floor: BigInt(v.f) };
};

/** Order of two feed positions: by seq, then id (lower-case UUID text sorts like Postgres uuids). */
export const compareFeedPosition = (a: { seq: bigint; id: string }, b: { seq: bigint; id: string }): number =>
  a.seq === b.seq ? (a.id === b.id ? 0 : a.id < b.id ? -1 : 1) : a.seq < b.seq ? -1 : 1;

/**
 * Whether a device holding `cursor` must resync: compaction has raised the floor since the cursor was
 * issued AND the cursor hasn't passed it — so the device may still hold a node whose delete was
 * compacted away. A cursor issued under the current floor (e.g. mid-way through a full sync, walking
 * old rows below it) is fine.
 */
export const mustResync = (cursor: SyncCursor, currentFloor: bigint): boolean =>
  cursor.seq < currentFloor && cursor.floor < currentFloor;
