// Fixture checks for the storage rules (HOA protocol 04: small ts-node scripts, no test framework).
// No database, no network — presigned URLs are local HMACs, so their shape is checked here too:
//
//   npm run check:storage
//
// The flows (uploads, purges, the outbox, reconciliation) are check:storage-db; R2 itself is
// check:r2-live, against a dev bucket.

// config/env.ts fails fast on missing REQUIRED vars: placeholders for any that are missing, set
// BEFORE the imports below load it (tsc keeps statement order in CommonJS output).
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://benchbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { BadRequestError } from "../common/errors/AppError";
import {
  DELETION_STORAGE_PURGE_DAYS,
  MAX_PARTS,
  PART_SIZE_BYTES,
  SINGLE_PUT_MAX_BYTES,
  STORAGE_MAX_OBJECT_BYTES,
  UPLOAD_CLEANUP_DELAY_SECONDS,
  UPLOAD_IDLE_EXPIRY_HOURS,
  UPLOAD_MAX_AGE_HOURS,
  UPLOAD_URL_TTL_SECONDS,
} from "../modules/files/files.policy";
import {
  accountPrefixes,
  attachmentDisposition,
  checkParts,
  fitsAllowance,
  normalizeMimeType,
  objectKeyFor,
  parseObjectKey,
  parsePartNumbers,
  partSizeOf,
  planUpload,
  thumbKeyFor,
  uploadExpiry,
  uploadUrlTtlSeconds,
} from "../modules/files/files.rules";
import { mayClaim, RETRY_AFTER_FAILURE_MS, STALE_INTERVAL_RUN_MS } from "../modules/jobs/jobs.schedule";
import {
  accountCleanupJobs,
  deleteObjectsJobs,
  parseOutboxJob,
  retryDelayMs,
  uploadCleanupJob,
} from "../modules/outbox/outbox.jobs";
import { createR2Store } from "../storage/r2Storage";

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
};

const throwsCode = (fn: () => unknown, code: string): void => {
  assert.throws(fn, (e: unknown) => e instanceof BadRequestError && e.code === code);
};

const MiB = 1024 * 1024;
const USER = "0f9e2a6c-1111-4222-8333-944455556666";
const BLOB = "7a1b2c3d-4444-4555-8666-777788889999";
const HOUR = 3_600_000;

const main = async (): Promise<void> => {
  // ---------------------------------------------------------------- upload plan
  await check("plan: one PUT up to 16 MiB, parts above; every part but the last is the same size", () => {
    assert.deepEqual(planUpload(0), { mode: "single", partSize: null, partCount: null });
    assert.deepEqual(planUpload(SINGLE_PUT_MAX_BYTES), { mode: "single", partSize: null, partCount: null });
    const just = planUpload(SINGLE_PUT_MAX_BYTES + 1);
    assert.deepEqual(just, { mode: "multipart", partSize: PART_SIZE_BYTES, partCount: 3 });
    const size = 20 * MiB + 123;
    const plan = planUpload(size);
    assert.deepEqual([plan.partSize, plan.partCount], [8 * MiB, 3]);
    const sizes = [1, 2, 3].map((n) => partSizeOf(n, plan.partSize!, plan.partCount!, size));
    assert.deepEqual(sizes, [8 * MiB, 8 * MiB, 4 * MiB + 123]);
    assert.equal(sizes.reduce((a, b) => a + b, 0), size);
    // An exact multiple: the last part is a full one, never empty.
    const even = planUpload(24 * MiB);
    assert.equal(even.partCount, 3);
    assert.equal(partSizeOf(3, even.partSize!, even.partCount!, 24 * MiB), 8 * MiB);
  });

  await check("plan: 10 GB fits 8 MiB parts; the largest object R2 takes still fits 10,000 parts", () => {
    const tenGb = planUpload(10_000_000_000);
    assert.equal(tenGb.partSize, PART_SIZE_BYTES);
    assert.equal(tenGb.partCount, Math.ceil(10_000_000_000 / PART_SIZE_BYTES));
    const huge = planUpload(STORAGE_MAX_OBJECT_BYTES);
    assert.ok(huge.partCount! <= MAX_PARTS, `${huge.partCount} parts`);
    assert.equal(huge.partSize! % MiB, 0, "whole MiB parts");
    assert.ok(huge.partSize! <= 5 * 1024 * MiB, "R2's 5 GiB part limit");
  });

  await check("parts: only the right sizes count; anything missing keeps the upload incomplete", () => {
    const plan = { partSize: 8, partCount: 3, totalSize: 20 };
    const part = (partNumber: number, size: number) => ({ partNumber, size, etag: `"e${partNumber}"` });
    const none = checkParts([], plan);
    assert.deepEqual([none.done, none.missing, none.complete], [[], [1, 2, 3], null]);
    const wrong = checkParts([part(1, 8), part(2, 7), part(3, 4)], plan);
    assert.deepEqual([wrong.done, wrong.missing], [[1, 3], [2]]);
    assert.equal(wrong.complete, null);
    const extra = checkParts([part(3, 4), part(1, 8), part(2, 8), part(4, 1)], plan);
    assert.deepEqual(extra.missing, []);
    assert.deepEqual(extra.complete?.map((p) => p.partNumber), [1, 2, 3], "in order, ignoring a part past the end");
  });

  await check("parts: a request names 1–50 distinct parts within the upload", () => {
    assert.deepEqual(parsePartNumbers([3, 1, 2], 3), [1, 2, 3]);
    for (const bad of [[], [0], [4], [1, 1], [1.5], ["1"], "1", null]) {
      assert.throws(() => parsePartNumbers(bad, 3), BadRequestError, JSON.stringify(bad));
    }
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    assert.equal(parsePartNumbers(fifty, 100).length, 50);
    assert.throws(() => parsePartNumbers([...fifty, 51], 100), BadRequestError, "51 at once");
  });

  // ---------------------------------------------------------------- keys
  await check("keys: per-account prefixes, never a file name; parsing rejects anything else", () => {
    assert.equal(objectKeyFor(USER, BLOB), `u/${USER}/${BLOB}`);
    assert.equal(thumbKeyFor(USER, BLOB), `t/${USER}/${BLOB}.webp`);
    assert.deepEqual(accountPrefixes(USER), [`u/${USER}/`, `t/${USER}/`]);
    assert.deepEqual(parseObjectKey(objectKeyFor(USER, BLOB)), { kind: "object", userId: USER, blobId: BLOB });
    assert.deepEqual(parseObjectKey(thumbKeyFor(USER, BLOB)), { kind: "thumb", userId: USER, blobId: BLOB });
    for (const bad of [`u/${USER}/${BLOB}.webp`, `t/${USER}/${BLOB}`, `u/${USER}/photo.jpg`, `x/${USER}/${BLOB}`, `u/${USER}/${BLOB}/x`, ""]) {
      assert.equal(parseObjectKey(bad), null, bad);
    }
  });

  // ---------------------------------------------------------------- lifetimes
  await check("expiry: slides 24 h with activity, never past 6 days; URLs never outlive the upload", () => {
    const created = new Date("2026-10-22T00:00:00Z");
    assert.equal(uploadExpiry(created, created).getTime(), created.getTime() + UPLOAD_IDLE_EXPIRY_HOURS * HOUR);
    const later = new Date(created.getTime() + 100 * HOUR);
    assert.equal(uploadExpiry(created, later).getTime(), later.getTime() + UPLOAD_IDLE_EXPIRY_HOURS * HOUR);
    const late = new Date(created.getTime() + (UPLOAD_MAX_AGE_HOURS - 1) * HOUR);
    assert.equal(uploadExpiry(created, late).getTime(), created.getTime() + UPLOAD_MAX_AGE_HOURS * HOUR, "capped");
    assert.ok(UPLOAD_MAX_AGE_HOURS < 7 * 24, "before R2's 7-day rule for unfinished multipart uploads");
    const now = new Date(created.getTime() + HOUR);
    assert.equal(uploadUrlTtlSeconds(new Date(now.getTime() + 10 * HOUR), now), UPLOAD_URL_TTL_SECONDS);
    assert.equal(uploadUrlTtlSeconds(new Date(now.getTime() + 600_000), now), 600);
    assert.equal(uploadUrlTtlSeconds(new Date(now.getTime() - 1000), now), 1, "never zero or negative");
    assert.ok(UPLOAD_CLEANUP_DELAY_SECONDS > UPLOAD_URL_TTL_SECONDS, "cleanup waits out every issued URL");
  });

  // ---------------------------------------------------------------- media types and names
  await check("media types: reduced to type/subtype in lower case; absent means octet-stream", () => {
    assert.equal(normalizeMimeType(undefined), "application/octet-stream");
    assert.equal(normalizeMimeType(null), "application/octet-stream");
    assert.equal(normalizeMimeType(""), "application/octet-stream");
    assert.equal(normalizeMimeType("Image/JPEG"), "image/jpeg");
    assert.equal(normalizeMimeType("text/plain; charset=utf-8"), "text/plain");
    assert.equal(normalizeMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    for (const bad of ["jpeg", "image/", "/jpeg", "image/jp eg", "image/jpeg\r\nX-Evil: 1", 42]) {
      throwsCode(() => normalizeMimeType(bad), "INVALID_MIME_TYPE");
    }
  });

  await check("downloads: the real name in Content-Disposition, safe for every client", () => {
    assert.equal(attachmentDisposition("photo.jpg"), `attachment; filename="photo.jpg"; filename*=UTF-8''photo.jpg`);
    assert.equal(
      attachmentDisposition("Résumé (final).pdf"),
      `attachment; filename="Resume (final).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.pdf`
    );
    const quoted = attachmentDisposition('say "hi" \\ there.txt');
    assert.ok(quoted.startsWith(`attachment; filename="say _hi_ _ there.txt"`), quoted);
    const cjk = attachmentDisposition("写真.png");
    assert.ok(cjk.includes(`filename="__.png"`) && cjk.includes("filename*=UTF-8''%E5%86%99%E7%9C%9F.png"), cjk);
    assert.ok(!/[\r\n]/.test(attachmentDisposition("a\r\nb")), "no header injection");
  });

  await check("allowance: stored + reserved + new − replaced must fit; null means no limit", () => {
    const base = { storedBytes: 1_500n, reservedBytes: 300n, size: 200n, replacedBytes: 0n };
    assert.equal(fitsAllowance({ ...base, allowance: 2_000n }), true);
    assert.equal(fitsAllowance({ ...base, size: 201n, allowance: 2_000n }), false);
    assert.equal(fitsAllowance({ ...base, size: 700n, replacedBytes: 500n, allowance: 2_000n }), true);
    assert.equal(fitsAllowance({ ...base, size: 10n ** 15n, allowance: null }), true);
  });

  // ---------------------------------------------------------------- outbox
  await check("outbox: deletes go in batches of 1000; cleanup waits out the URLs; accounts swept twice", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    const keys = Array.from({ length: 2500 }, (_, i) => `u/${USER}/${i}`);
    const jobs = deleteObjectsJobs(keys, now);
    assert.deepEqual(jobs.map((j) => (j.kind === "DELETE_OBJECTS" ? j.payload.keys.length : -1)), [1000, 1000, 500]);
    assert.deepEqual(deleteObjectsJobs([], now), []);

    const session = { objectKey: objectKeyFor(USER, BLOB), thumbKey: thumbKeyFor(USER, BLOB), r2UploadId: "mp-1" };
    assert.equal(uploadCleanupJob(session, now, false).runAfter.getTime(), now.getTime());
    assert.equal(uploadCleanupJob(session, now, true).runAfter.getTime(), now.getTime() + UPLOAD_CLEANUP_DELAY_SECONDS * 1000);

    const sweep = accountCleanupJobs(USER, now);
    assert.equal(sweep.length, 4);
    assert.ok(sweep.every((j) => j.kind === "DELETE_PREFIX" && accountPrefixes(USER).includes(j.payload.prefix)));
    const latest = Math.max(...sweep.map((j) => j.runAfter.getTime()));
    assert.ok(latest - now.getTime() < DELETION_STORAGE_PURGE_DAYS * 86_400_000, "inside the public promise");
  });

  await check("outbox: backoff doubles from a minute to an hour; unreadable jobs and wide prefixes are refused", () => {
    assert.deepEqual([1, 2, 3, 4, 7, 8, 100].map((n) => retryDelayMs(n) / 60_000), [1, 2, 4, 8, 60, 60, 60]);
    assert.deepEqual(parseOutboxJob("DELETE_OBJECTS", { keys: ["a"] }), { kind: "DELETE_OBJECTS", payload: { keys: ["a"] } });
    assert.deepEqual(parseOutboxJob("CLEANUP_UPLOAD", { key: "k", thumbKey: "t" }), {
      kind: "CLEANUP_UPLOAD",
      payload: { key: "k", thumbKey: "t", uploadId: null },
    });
    assert.deepEqual(parseOutboxJob("DELETE_PREFIX", { prefix: `u/${USER}/` }), { kind: "DELETE_PREFIX", payload: { prefix: `u/${USER}/` } });
    // A sweep can only ever cover one account's prefix — never "", "u/" or the whole bucket.
    for (const prefix of ["", "u/", "t/", `u/${USER}`, `x/${USER}/`, `u/${USER}/${BLOB}`]) {
      assert.throws(() => parseOutboxJob("DELETE_PREFIX", { prefix }), /Unreadable/, prefix);
    }
    assert.throws(() => parseOutboxJob("DELETE_OBJECTS", { keys: "a" }), /Unreadable/);
    assert.throws(() => parseOutboxJob("NOPE", {}), /Unreadable/);
  });

  // ---------------------------------------------------------------- interval jobs
  await check("jobs: an interval job runs every interval, retries sooner after a failure, and recovers from a crash", () => {
    const t = new Date("2026-10-22T10:00:00Z");
    const at = (ms: number) => new Date(t.getTime() + ms);
    const minute = 60_000;
    const quarter = 15 * minute;
    assert.equal(mayClaim(null, t, minute), true);
    const ran = { status: "SUCCEEDED", startedAt: t, finishedAt: at(2_000) };
    assert.equal(mayClaim(ran, at(30_000), minute), false);
    assert.equal(mayClaim(ran, at(minute - 1_000), minute), true, "a tick a moment early still runs");
    assert.equal(mayClaim(ran, at(14 * minute), quarter), false);
    assert.equal(mayClaim(ran, at(quarter), quarter), true);
    const failed = { status: "FAILED", startedAt: t, finishedAt: at(1_000) };
    assert.equal(mayClaim(failed, at(2 * minute), minute), true);
    assert.equal(mayClaim(failed, at(10 * minute), quarter), false);
    assert.equal(mayClaim(failed, at(RETRY_AFTER_FAILURE_MS + 1_000), quarter), true);
    const running = { status: "RUNNING", startedAt: t, finishedAt: null };
    assert.equal(mayClaim(running, at(5 * minute), minute), false);
    assert.equal(mayClaim(running, at(STALE_INTERVAL_RUN_MS + 1), minute), true, "a crashed run is taken over");
    // Daily semantics are unchanged without an interval.
    assert.equal(mayClaim(ran, at(48 * HOUR)), false);
  });

  // ---------------------------------------------------------------- presigned URLs (local HMAC)
  await check("R2 URLs: uploads sign Content-Length and carry no checksum; downloads carry the name and type", async () => {
    const store = createR2Store({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "benchbox-files",
      accessKeyId: "a".repeat(32),
      secretAccessKey: "b".repeat(64),
    });
    const key = objectKeyFor(USER, BLOB);
    const put = new URL(await store.presignPut(key, 12345, 3600));
    assert.equal(put.origin + put.pathname, `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/benchbox-files/${key}`);
    assert.equal(put.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
    assert.equal(put.searchParams.get("X-Amz-Expires"), "3600");
    const part = new URL(await store.presignUploadPart(key, "UPLOAD", 7, 8 * MiB, 600));
    assert.equal(part.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
    assert.deepEqual([part.searchParams.get("partNumber"), part.searchParams.get("uploadId")], ["7", "UPLOAD"]);
    for (const url of [put, part]) {
      const params = [...url.searchParams.keys()].map((k) => k.toLowerCase());
      assert.ok(!params.some((k) => k.includes("checksum")), `no checksum parameters: ${params.join(",")}`);
    }
    const disposition = attachmentDisposition("Résumé.pdf");
    const get = new URL(await store.presignGet(key, 900, { contentType: "application/pdf", contentDisposition: disposition }));
    assert.equal(get.searchParams.get("response-content-type"), "application/pdf");
    assert.equal(get.searchParams.get("response-content-disposition"), disposition);
    assert.equal(get.searchParams.get("X-Amz-Expires"), "900");
  });

  console.log(`\ncheck:storage — ${passed} checks passed`);
};

void main();
