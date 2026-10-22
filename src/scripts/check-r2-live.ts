// Live checks against a real R2 bucket — a DEV bucket only; the script refuses a bucket whose name
// doesn't say dev/test/check. They confirm what the code relies on and the fakes can't prove:
//
//   npm run check:r2-live        (R2_* in .env pointing at the dev bucket)
//
//   - a presigned PUT works, and a body of a different length than signed is refused;
//   - a presigned GET answers with the name and type BenchBox asks for, and serves ranges;
//   - multipart: parts, ListParts, completion, abort;
//   - listing and batch delete.
// Everything it creates lives under one random u/<uuid>/ prefix and is deleted at the end.

import dotenv from "dotenv";
dotenv.config({ quiet: true });

for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://benchbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config/env";
import { attachmentDisposition, objectKeyFor, partSizeOf, planUpload, thumbKeyFor } from "../modules/files/files.rules";
import { createR2Store } from "../storage/r2Storage";

if (!config.r2) {
  console.error("check:r2-live needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (a dev bucket) in .env.");
  process.exit(1);
}
if (!/(dev|test|check)/.test(config.r2.bucket)) {
  console.error(`check:r2-live runs only against a dev bucket (got "${config.r2.bucket}"). Refusing.`);
  process.exit(1);
}

const store = createR2Store(config.r2);
const owner = randomUUID();
const prefix = `u/${owner}/`;

let passed = 0;
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    await cleanup();
    process.exit(1);
  }
};

const cleanup = async (): Promise<void> => {
  for (const upload of (await store.listMultipartUploads(prefix)).items) await store.abortMultipartUpload(upload.key, upload.uploadId);
  for (const p of [prefix, `t/${owner}/`]) {
    for (;;) {
      const page = await store.listObjects(p);
      if (page.items.length === 0) break;
      await store.deleteObjects(page.items.map((o) => o.key));
    }
  }
};

// A plain PUT with a known length, the way the app sends bytes (fetch sets Content-Length).
const put = (url: string, body: Buffer): Promise<Response> => fetch(url, { method: "PUT", body: new Uint8Array(body) });

const main = async (): Promise<void> => {
  console.log(`bucket ${config.r2!.bucket}, prefix ${prefix}`);
  const single = objectKeyFor(owner, randomUUID());
  const bytes = randomBytes(4096);

  await check("presigned PUT: the signed length goes up; any other length is refused", async () => {
    const url = await store.presignPut(single, bytes.length, 600);
    assert.equal((await put(url, bytes)).status, 200);
    assert.deepEqual(await store.headObject(single), { size: bytes.length });
    const longer = await put(url, Buffer.concat([bytes, Buffer.from("x")]));
    assert.equal(longer.status, 403, `a longer body must be refused (got ${longer.status})`);
    const shorter = await put(url, bytes.subarray(1));
    assert.equal(shorter.status, 403, `a shorter body must be refused (got ${shorter.status})`);
    assert.deepEqual(await store.headObject(single), { size: bytes.length }, "the object is unchanged");
  });

  await check("presigned GET: the real name and type come back, and ranges work", async () => {
    const disposition = attachmentDisposition("Résumé (final).pdf");
    const url = await store.presignGet(single, 600, { contentType: "application/pdf", contentDisposition: disposition });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), disposition);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
    const range = await fetch(url, { headers: { Range: "bytes=100-199" } });
    assert.equal(range.status, 206);
    assert.ok(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(100, 200)));
  });

  await check("multipart: parts signed per size, listed, assembled; HeadObject reports the whole", async () => {
    const key = objectKeyFor(owner, randomUUID());
    const size = 8 * 1024 * 1024 + 1000;
    const plan = planUpload(size);
    assert.equal(plan.partCount, 2);
    const uploadId = await store.createMultipartUpload(key);
    const body = randomBytes(size);
    let offset = 0;
    for (let n = 1; n <= plan.partCount!; n += 1) {
      const length = partSizeOf(n, plan.partSize!, plan.partCount!, size);
      const url = await store.presignUploadPart(key, uploadId, n, length, 600);
      assert.equal((await put(url, body.subarray(offset, offset + length))).status, 200, `part ${n}`);
      offset += length;
    }
    const parts = await store.listParts(key, uploadId);
    assert.deepEqual(parts?.map((p) => [p.partNumber, p.size]), [[1, plan.partSize], [2, 1000]]);
    await store.completeMultipartUpload(key, uploadId, parts!);
    assert.deepEqual(await store.headObject(key), { size });
    assert.equal(await store.listParts(key, uploadId), null, "a completed upload is no longer listed");
  });

  await check("abort: an unfinished upload goes, and aborting twice is harmless", async () => {
    const key = objectKeyFor(owner, randomUUID());
    const uploadId = await store.createMultipartUpload(key);
    assert.ok((await store.listMultipartUploads(prefix)).items.some((u) => u.uploadId === uploadId));
    await store.abortMultipartUpload(key, uploadId);
    await store.abortMultipartUpload(key, uploadId);
    assert.equal(await store.listParts(key, uploadId), null);
  });

  await check("listing and batch delete (missing keys are fine)", async () => {
    const thumb = thumbKeyFor(owner, randomUUID());
    assert.equal((await put(await store.presignPut(thumb, 10, 600), randomBytes(10))).status, 200);
    const listed = (await store.listObjects(prefix)).items.map((o) => o.key);
    assert.ok(listed.includes(single), "the PUT object is listed");
    let found = false;
    let next: string | null = null;
    do {
      const page = await store.listPrefixes("u/", next);
      found ||= page.items.includes(prefix);
      next = page.next;
    } while (next && !found);
    assert.ok(found, "the account's prefix is listed under u/");
    await store.deleteObjects([single, thumb, objectKeyFor(owner, randomUUID())]);
    assert.equal(await store.headObject(single), null);
    assert.equal(await store.headObject(thumb), null);
  });

  await cleanup();
  console.log(`\ncheck:r2-live — ${passed} checks passed`);
};

void main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
