// Integration checks for uploads, downloads, metering, the outbox and reconciliation, against a real
// PostgreSQL — a LOCAL, disposable database only; the script refuses anything else:
//
//   npm run check:storage-db        (DATABASE_URL from .env, schema migrated)
//
// R2 is an in-memory stand-in (support/fakeObjectStore.ts) that also plays the app's part, PUTting
// to the presigned URLs. The clock is the script's. After the flows that touch storage, the books
// are audited: stored bytes = the sum of live blobs = the event log's last total, every live file
// has content, every live blob has exactly one file and an object in the bucket.

import dotenv from "dotenv";
dotenv.config({ quiet: true });

let dbHost = "";
try {
  dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  dbHost = "";
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(dbHost)) {
  console.error("check:storage-db runs only against a LOCAL database (DATABASE_URL host must be localhost). Refusing.");
  process.exit(1);
}
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://brimbox.ferbotz.com",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma/client";
import { AccountService } from "../modules/account/service/account.service";
import { UploadDto } from "../modules/files/dto/upload.dto";
import {
  FREE_STORAGE_BYTES,
  MAX_PENDING_UPLOADS,
  UPLOAD_CLEANUP_DELAY_SECONDS,
  UPLOAD_MAX_AGE_HOURS,
} from "../modules/files/files.policy";
import { objectKeyFor, thumbKeyFor } from "../modules/files/files.rules";
import { FilesService } from "../modules/files/service/files.service";
import { ReconcileService } from "../modules/files/service/reconcile.service";
import { StartUploadInput, UploadsService } from "../modules/files/service/uploads.service";
import { meteringService } from "../modules/metering/service/metering.service";
import { NodeDto } from "../modules/nodes/dto/node.dto";
import { TRASH_RETENTION_DAYS } from "../modules/nodes/nodes.policy";
import { TreeService } from "../modules/nodes/service/tree.service";
import { OutboxService } from "../modules/outbox/service/outbox.service";
import { SyncService } from "../modules/sync/service/sync.service";
import { FakeObjectStore } from "./support/fakeObjectStore";

// ---------------------------------------------------------------- harness
let clock = new Date("2026-10-22T10:00:00Z");
const now = (): Date => clock;
const advanceMinutes = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

const fake = new FakeObjectStore();
const uploads = new UploadsService({ now, store: fake });
const files = new FilesService({ now, store: fake });
const outbox = new OutboxService({ now, store: fake });
const reconcile = new ReconcileService({ now, store: fake });
const tree = new TreeService({ now });
const sync = new SyncService();
const fakeVerify = async (idToken: string) => {
  const [sub, iat] = idToken.split("|");
  return { sub: sub!, email: `${sub}@example.test`, name: null, photoUrl: null, issuedAt: Number(iat) };
};
const account = new AccountService({ verifyIdToken: fakeVerify, now });

const MAX_FILE = 10_000_000_000;
const MiB = 1024 * 1024;

const RUN = Date.now().toString(36);
const createdUserIds = new Set<string>();
const newUser = async (label: string): Promise<string> => {
  const user = await prisma.user.create({ data: { googleSub: `check-${RUN}-${label}`, email: `${label}@example.test` } });
  createdUserIds.add(user.id);
  return user.id;
};

const startInput = (overrides: Partial<StartUploadInput>): StartUploadInput => ({
  id: randomUUID(),
  fileId: randomUUID(),
  parentId: null,
  name: "file.bin",
  size: 1000,
  mimeType: "application/octet-stream",
  onConflict: "fail",
  thumbnailSize: null,
  ...overrides,
});

const start = async (userId: string, overrides: Partial<StartUploadInput> = {}): Promise<UploadDto> =>
  (await uploads.start(userId, startInput(overrides), MAX_FILE)).upload;

/** The app's side of an upload: the whole file, or every part except `skip`. */
const sendBytes = async (userId: string, upload: UploadDto, skip: number[] = []): Promise<void> => {
  if (upload.mode === "single") {
    fake.put(upload.put!.url, upload.size);
    return;
  }
  const numbers = Array.from({ length: upload.partCount! }, (_, i) => i + 1).filter((n) => !skip.includes(n));
  for (let i = 0; i < numbers.length; i += 50) {
    const { parts } = await uploads.partUrls(userId, upload.id, numbers.slice(i, i + 50));
    for (const part of parts) fake.put(part.url, part.size);
  }
};

/** A whole upload, start to finish. Returns the file. */
const uploadFile = async (
  userId: string,
  overrides: Partial<StartUploadInput> = {},
  options: { thumbnail?: boolean } = {}
): Promise<NodeDto> => {
  const upload = await start(userId, { ...overrides, thumbnailSize: options.thumbnail ? 100 : null });
  await sendBytes(userId, upload);
  if (upload.thumbnailPut) fake.put(upload.thumbnailPut.url, 100);
  const done = await uploads.complete(userId, upload.id, undefined);
  assert.equal(done.state, "completed");
  return done.node!;
};

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => {
    assert.equal((e as { code?: string }).code, code);
    return true;
  });
};

const storedBytes = async (userId: string): Promise<bigint> =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { storedBytes: true } })).storedBytes;

const events = async (userId: string) =>
  prisma.storageEvent.findMany({ where: { userId }, orderBy: { id: "asc" }, select: { deltaBytes: true, totalAfter: true, reason: true } });

/** Jobs waiting in the outbox that mention this account. */
const queuedFor = async (userId: string) =>
  (await prisma.outboxJob.findMany({ orderBy: { id: "asc" } })).filter((job) => JSON.stringify(job.payload).includes(userId));

/** The books must balance (see the header). */
const audit = async (userId: string): Promise<void> => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const blobs = await prisma.blob.findMany({ where: { userId, purgedAt: null } });
  const total = blobs.reduce((sum, blob) => sum + blob.size, 0n);
  assert.equal(user.storedBytes, total, "stored bytes = the sum of live blobs");
  let running = 0n;
  for (const event of await events(userId)) {
    running += event.deltaBytes;
    assert.equal(event.totalAfter, running, "each event's total follows from the deltas");
  }
  assert.equal(running, user.storedBytes, "the log's last total = stored bytes");
  const liveFiles = await prisma.node.findMany({ where: { userId, kind: "FILE", deletedAt: null } });
  for (const file of liveFiles) assert.ok(blobs.some((blob) => blob.id === file.blobId), `file ${file.name} has live content`);
  for (const blob of blobs) {
    assert.equal(liveFiles.filter((file) => file.blobId === blob.id).length, 1, `blob ${blob.id} has exactly one file`);
    assert.ok(fake.objects.has(blob.objectKey), `the object of blob ${blob.id} is in the bucket`);
  }
};

const cleanup = async (): Promise<void> => {
  const ids = [...createdUserIds];
  for (const id of ids) await prisma.$executeRaw`DELETE FROM "OutboxJob" WHERE "payload"::text LIKE ${`%${id}%`}`;
  await prisma.node.deleteMany({ where: { userId: { in: ids } } });
  await prisma.blob.deleteMany({ where: { userId: { in: ids } } });
  await prisma.uploadSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.storageEvent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
};

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

// ---------------------------------------------------------------- flows
const main = async (): Promise<void> => {
  const me = await newUser("me");
  const other = await newUser("other");

  await check("single upload: start, PUT, complete — the file appears, billed by the size R2 reports", async () => {
    const upload = await start(me, { name: "photo.jpg", size: 1234, mimeType: "image/jpeg", thumbnailSize: 100 });
    assert.deepEqual([upload.state, upload.mode, upload.partCount], ["pending", "single", null]);
    assert.ok(upload.put && upload.thumbnailPut, "URLs for the file and its thumbnail");
    assert.equal(await storedBytes(me), 0n, "nothing billed before completion");
    fake.put(upload.put.url, 1234);
    fake.put(upload.thumbnailPut.url, 100);
    const done = await uploads.complete(me, upload.id, undefined);
    const node = done.node!;
    assert.deepEqual(
      [done.state, node.id, node.kind, node.name, node.size, node.mimeType, node.contentId, node.hasThumbnail],
      ["completed", upload.fileId, "file", "photo.jpg", 1234, "image/jpeg", upload.id, true]
    );
    assert.equal(await storedBytes(me), 1234n);
    assert.deepEqual(await events(me), [{ deltaBytes: 1234n, totalAfter: 1234n, reason: "UPLOAD" }]);
    const feed = await sync.changes(me, undefined, undefined);
    assert.ok(feed.changes.some((change) => change.id === node.id && change.contentId === upload.id));
    // Completing again, or starting again with the same id, answers with the same file.
    assert.equal((await uploads.complete(me, upload.id, undefined)).node!.id, node.id);
    const again = await uploads.start(me, startInput({ id: upload.id, fileId: upload.fileId, name: "photo.jpg", size: 1234 }), MAX_FILE);
    assert.deepEqual([again.created, again.upload.state, again.upload.node?.id], [false, "completed", node.id]);
    assert.equal(await storedBytes(me), 1234n, "billed once");
    await audit(me);
  });

  await check("start: idempotent by upload id; ids already in use are refused", async () => {
    const first = await uploads.start(me, startInput({ name: "retry.bin" }), MAX_FILE);
    const second = await uploads.start(me, startInput({ id: first.upload.id, fileId: first.upload.fileId, name: "retry.bin" }), MAX_FILE);
    assert.deepEqual([first.created, second.created, second.upload.id], [true, false, first.upload.id]);
    await rejectsWith(uploads.start(me, startInput({ id: first.upload.id, fileId: first.upload.fileId, size: 999 }), MAX_FILE), "ID_CONFLICT");
    await rejectsWith(uploads.start(other, startInput({ id: first.upload.id, fileId: first.upload.fileId }), MAX_FILE), "ID_CONFLICT");
    await rejectsWith(start(me, { fileId: first.upload.fileId, name: "other.bin" }), "ID_CONFLICT"); // reserved by a pending upload
    const folder = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "Id clash", onConflict: "fail" });
    await rejectsWith(start(me, { fileId: folder.node.id, name: "x.bin" }), "ID_CONFLICT"); // an existing node
    await uploads.abort(me, first.upload.id);
  });

  await check("start: names, sizes, media types, thumbnails and folders are checked before any bytes move", async () => {
    await rejectsWith(uploads.start(me, startInput({ size: 5001 }), 5000), "FILE_TOO_LARGE");
    await rejectsWith(start(me, { mimeType: "not a type" }), "INVALID_MIME_TYPE");
    await rejectsWith(start(me, { name: "a/b" }), "INVALID_NAME");
    await rejectsWith(start(me, { thumbnailSize: 0 }), "BAD_REQUEST");
    await rejectsWith(start(me, { thumbnailSize: 256 * 1024 + 1 }), "BAD_REQUEST");
    await rejectsWith(start(me, { parentId: randomUUID() }), "NOT_FOUND");
    const theirs = await tree.createFolder(other, { id: randomUUID(), parentId: null, name: "Theirs", onConflict: "fail" });
    await rejectsWith(start(me, { parentId: theirs.node.id }), "NOT_FOUND");
    const binned = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "Binned", onConflict: "fail" });
    await tree.trash(me, binned.node.id);
    await rejectsWith(start(me, { parentId: binned.node.id }), "NODE_TRASHED");
    const file = await uploadFile(me, { name: "not-a-folder.txt", size: 10 });
    await rejectsWith(start(me, { parentId: file.id }), "NOT_A_FOLDER");
    const typed = await start(me, { name: "typed.txt", mimeType: "Text/Plain; charset=utf-8" });
    assert.equal(typed.mimeType, "text/plain");
    await uploads.abort(me, typed.id);
    await audit(me);
  });

  await check("name clash: fail refuses at the start; rename numbers; replace keeps the file and swaps its content", async () => {
    const box = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "Clash", onConflict: "fail" });
    const original = await uploadFile(me, { parentId: box.node.id, name: "doc.pdf", size: 500 }, { thumbnail: true });
    await rejectsWith(start(me, { parentId: box.node.id, name: "DOC.pdf" }), "NAME_CONFLICT");
    const renamed = await uploadFile(me, { parentId: box.node.id, name: "doc.pdf", size: 10, onConflict: "rename" });
    assert.equal(renamed.name, "doc (1).pdf");

    const before = await storedBytes(me);
    const replacing = await start(me, { parentId: box.node.id, name: "Doc.PDF", size: 700, mimeType: "application/pdf", onConflict: "replace" });
    await sendBytes(me, replacing);
    const replaced = (await uploads.complete(me, replacing.id, undefined)).node!;
    assert.deepEqual(
      [replaced.id, replaced.name, replaced.size, replaced.contentId, replaced.hasThumbnail, replaced.mimeType],
      [original.id, "doc.pdf", 700, replacing.id, false, "application/pdf"],
      "same file, same name, new content"
    );
    assert.equal(await storedBytes(me), before - 500n + 700n);
    assert.deepEqual((await events(me)).slice(-2).map((e) => [e.reason, e.deltaBytes]), [["UPLOAD", 700n], ["REPLACE", -500n]]);
    const old = await prisma.blob.findUniqueOrThrow({ where: { id: original.contentId! } });
    assert.ok(old.purgedAt, "the old content is released");
    const queued = (await queuedFor(me)).flatMap((job) => (job.kind === "DELETE_OBJECTS" ? (job.payload as { keys: string[] }).keys : []));
    assert.ok(queued.includes(objectKeyFor(me, original.contentId!)) && queued.includes(thumbKeyFor(me, original.contentId!)));

    // A folder is never replaced by a file: the file is numbered instead.
    await tree.createFolder(me, { id: randomUUID(), parentId: box.node.id, name: "notes", onConflict: "fail" });
    const beside = await uploadFile(me, { parentId: box.node.id, name: "notes", size: 5, onConflict: "replace" });
    assert.equal(beside.name, "notes (1)");
    await outbox.drain();
    assert.equal(fake.objects.has(objectKeyFor(me, original.contentId!)), false, "the drain deleted the old object");
    await audit(me);
  });

  await check("a clash that appears during the upload: complete says NAME_CONFLICT and keeps it; completing with rename finishes it", async () => {
    const upload = await start(me, { name: "late.txt", size: 20 });
    await sendBytes(me, upload);
    await uploadFile(me, { name: "late.txt", size: 30 }); // someone else got the name first
    await rejectsWith(uploads.complete(me, upload.id, undefined), "NAME_CONFLICT");
    assert.equal((await uploads.get(me, upload.id)).state, "pending", "nothing lost");
    const done = await uploads.complete(me, upload.id, "rename");
    assert.equal(done.node!.name, "late (1).txt");
    await audit(me);
  });

  await check("multipart: part URLs signed per size; resume lists what R2 holds; completion needs every part right", async () => {
    const size = 20 * MiB + 123;
    const upload = await start(me, { name: "video.mp4", size, mimeType: "video/mp4" });
    assert.deepEqual([upload.mode, upload.partSize, upload.partCount, upload.put], ["multipart", 8 * MiB, 3, null]);
    const { parts } = await uploads.partUrls(me, upload.id, [3, 1, 2]);
    assert.deepEqual(parts.map((p) => [p.partNumber, p.size]), [[1, 8 * MiB], [2, 8 * MiB], [3, 4 * MiB + 123]]);
    await rejectsWith(uploads.partUrls(me, upload.id, [4]), "BAD_REQUEST");
    fake.put(parts[0]!.url, parts[0]!.size);
    fake.put(parts[2]!.url, parts[2]!.size);
    assert.throws(() => fake.put(parts[1]!.url, 100), /SignatureDoesNotMatch/, "a wrong-sized body is refused by the signature");
    await rejectsWith(uploads.complete(me, upload.id, undefined), "UPLOAD_INCOMPLETE");
    assert.deepEqual((await uploads.get(me, upload.id)).uploadedParts, [1, 3], "resume: send part 2");
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: upload.id } });
    fake.putPartUnsigned(session.r2UploadId!, 2, 5); // a part of the wrong size doesn't count
    assert.deepEqual((await uploads.get(me, upload.id)).uploadedParts, [1, 3]);
    fake.put(parts[1]!.url, parts[1]!.size); // re-sending a part replaces it
    const node = (await uploads.complete(me, upload.id, undefined)).node!;
    assert.equal(node.size, size);
    assert.equal(fake.objects.get(objectKeyFor(me, upload.id))?.size, size);
    assert.equal(fake.multipart.has(session.r2UploadId!), false);
    const single = await start(me, { name: "small.bin", size: 10 });
    await rejectsWith(uploads.partUrls(me, single.id, [1]), "NOT_MULTIPART");
    await uploads.abort(me, single.id);
    await audit(me);
  });

  await check("complete recovers when R2 assembled the file but the server never recorded it", async () => {
    const upload = await start(me, { name: "crash.bin", size: 17 * MiB });
    await sendBytes(me, upload);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: upload.id } });
    const held = await fake.listParts(session.objectKey, session.r2UploadId!);
    await fake.completeMultipartUpload(session.objectKey, session.r2UploadId!, held!); // …then the server "crashed"
    assert.deepEqual((await uploads.get(me, upload.id)).uploadedParts, [1, 2, 3], "resume says: just complete");
    const node = (await uploads.complete(me, upload.id, undefined)).node!;
    assert.equal(node.size, 17 * MiB);
    await audit(me);
  });

  await check("a size that doesn't match fails the upload, bills nothing, and queues its cleanup", async () => {
    const before = await storedBytes(me);
    const upload = await start(me, { name: "short.bin", size: 1000 });
    fake.objects.set(objectKeyFor(me, upload.id), { size: 999, lastModified: new Date() });
    await rejectsWith(uploads.complete(me, upload.id, undefined), "SIZE_MISMATCH");
    assert.equal((await uploads.get(me, upload.id)).state, "failed");
    await rejectsWith(uploads.complete(me, upload.id, undefined), "UPLOAD_ENDED");
    assert.equal(await storedBytes(me), before);
    const cleanupJob = (await queuedFor(me)).find((job) => JSON.stringify(job.payload).includes(upload.id));
    assert.equal(cleanupJob?.kind, "CLEANUP_UPLOAD");
    await audit(me);
  });

  await check("storage limit: reservations count, a replacement nets out the file it replaces, and the limit holds", async () => {
    const u = await newUser("limit");
    const big = await start(u, { name: "big.bin", size: 1_500_000_000 });
    await rejectsWith(start(u, { name: "more.bin", size: 600_000_000 }), "STORAGE_LIMIT_REACHED");
    await uploads.abort(u, big.id); // the reservation goes with it
    const kept = await uploadFile(u, { name: "kept.bin", size: 1_900_000_000 });
    const usage = await meteringService.usage(u);
    assert.deepEqual([usage.usedBytes, usage.limitBytes, usage.freeBytes], [1_900_000_000, FREE_STORAGE_BYTES, FREE_STORAGE_BYTES]);
    // Replacing the 1.9 GB file with a 1.95 GB one fits: the old bytes go when the new ones arrive.
    const swap = await start(u, { name: "kept.bin", size: 1_950_000_000, onConflict: "replace" });
    await rejectsWith(start(u, { name: "extra.bin", size: 200_000_000 }), "STORAGE_LIMIT_REACHED");
    await sendBytes(u, swap);
    const swapped = (await uploads.complete(u, swap.id, undefined)).node!;
    assert.deepEqual([swapped.id, swapped.size], [kept.id, 1_950_000_000]);
    assert.equal(await storedBytes(u), 1_950_000_000n);
    await audit(u);
  });

  await check(`at most ${MAX_PENDING_UPLOADS} uploads in progress per account`, async () => {
    const u = await newUser("busy");
    const started: string[] = [];
    for (let i = 0; i < MAX_PENDING_UPLOADS; i += 1) started.push((await start(u, { name: `f${i}.bin`, size: 1 })).id);
    await rejectsWith(start(u, { name: "one-more.bin", size: 1 }), "TOO_MANY_UPLOADS");
    await uploads.abort(u, started[0]!);
    await start(u, { name: "one-more.bin", size: 1 });
  });

  await check("cancel: idempotent; the bytes go once the issued URLs expire; a finished upload can't be cancelled", async () => {
    const upload = await start(me, { name: "cancel.bin", size: 17 * MiB });
    await sendBytes(me, upload, [3]);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: upload.id } });
    await uploads.abort(me, upload.id);
    await uploads.abort(me, upload.id);
    assert.equal((await uploads.get(me, upload.id)).state, "aborted");
    await rejectsWith(uploads.partUrls(me, upload.id, [3]), "UPLOAD_ENDED");
    await rejectsWith(uploads.complete(me, upload.id, undefined), "UPLOAD_ENDED");
    await outbox.drain();
    assert.ok(fake.multipart.has(session.r2UploadId!), "not yet: a URL handed out may still be in use");
    advanceMinutes(UPLOAD_CLEANUP_DELAY_SECONDS / 60 + 1);
    await outbox.drain();
    assert.equal(fake.multipart.has(session.r2UploadId!), false, "aborted in R2");
    const finished = await uploadFile(me, { name: "finished.bin", size: 3 });
    const finishedSession = await prisma.uploadSession.findFirstOrThrow({ where: { resultNodeId: finished.id } });
    await rejectsWith(uploads.abort(me, finishedSession.id), "UPLOAD_COMPLETED");
  });

  await check("the folder is trashed during the upload: the file lands in the root, not in the trash", async () => {
    const box = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "Doomed", onConflict: "fail" });
    const upload = await start(me, { parentId: box.node.id, name: "orphan.txt", size: 9 });
    await sendBytes(me, upload);
    await tree.trash(me, box.node.id);
    const node = (await uploads.complete(me, upload.id, undefined)).node!;
    assert.deepEqual([node.parentId, node.trashedAt], [null, null]);
    await audit(me);
  });

  await check("downloads and thumbnails: your own files only; the trash still downloads; purged files don't", async () => {
    const file = await uploadFile(me, { name: "Résumé.pdf", size: 64, mimeType: "application/pdf" }, { thumbnail: true });
    const link = new URL((await files.download(me, file.id)).url);
    assert.equal(link.pathname, `/${objectKeyFor(me, file.contentId!)}`);
    assert.equal(link.searchParams.get("type"), "application/pdf");
    assert.match(link.searchParams.get("disposition") ?? "", /filename\*=UTF-8''R%C3%A9sum%C3%A9\.pdf/);
    assert.equal(new URL(await files.thumbnailUrl(me, file.id)).pathname, `/${thumbKeyFor(me, file.contentId!)}`);
    await rejectsWith(files.download(other, file.id), "NOT_FOUND");
    const plain = await uploadFile(me, { name: "plain.bin", size: 4 });
    await rejectsWith(files.thumbnailUrl(me, plain.id), "NOT_FOUND");
    const folder = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "Not a file", onConflict: "fail" });
    await rejectsWith(files.download(me, folder.node.id), "NOT_FOUND");
    await tree.trash(me, file.id);
    await files.download(me, file.id); // still stored, still billed: still downloadable
    await tree.purge(me, file.id);
    await rejectsWith(files.download(me, file.id), "NOT_FOUND");
    await audit(me);
  });

  await check("purge releases the bytes in the same transaction and queues the objects' deletion; the drain deletes them", async () => {
    const u = await newUser("purge");
    const box = await tree.createFolder(u, { id: randomUUID(), parentId: null, name: "Box", onConflict: "fail" });
    const inner = await tree.createFolder(u, { id: randomUUID(), parentId: box.node.id, name: "Inner", onConflict: "fail" });
    const a = await uploadFile(u, { parentId: box.node.id, name: "a.bin", size: 100 }, { thumbnail: true });
    const b = await uploadFile(u, { parentId: inner.node.id, name: "b.bin", size: 200 });
    const loose = await uploadFile(u, { name: "loose.bin", size: 50 });
    await tree.trash(u, box.node.id);
    assert.equal(await storedBytes(u), 350n, "the trash still counts");
    assert.equal((await meteringService.usage(u)).trashBytes, 300);
    await tree.purge(u, box.node.id);
    assert.equal(await storedBytes(u), 50n);
    assert.deepEqual((await events(u)).slice(-1)[0], { deltaBytes: -300n, totalAfter: 50n, reason: "PURGE" });
    const keys = [objectKeyFor(u, a.contentId!), thumbKeyFor(u, a.contentId!), objectKeyFor(u, b.contentId!)];
    assert.ok(keys.every((key) => fake.objects.has(key)), "still there until the drain");
    await outbox.drain();
    assert.ok(keys.every((key) => !fake.objects.has(key)), "gone after it");
    // Empty trash and the 30-day auto-purge release bytes the same way.
    await tree.trash(u, loose.id);
    advanceMinutes((TRASH_RETENTION_DAYS + 1) * 24 * 60);
    await tree.purgeExpiredTrash(now());
    assert.equal(await storedBytes(u), 0n);
    await outbox.drain();
    assert.deepEqual(fake.under(`u/${u}/`).objects, []);
    await audit(u);
  });

  await check("the outbox retries a failing job with backoff and doesn't lose it", async () => {
    const u = await newUser("retry");
    const file = await uploadFile(u, { name: "stubborn.bin", size: 7 });
    await outbox.drain(); // nothing else due, so the failure below hits this job
    await tree.trash(u, file.id);
    await tree.purge(u, file.id);
    fake.failNext("deleteObjects");
    assert.match(await outbox.drain(), /0 done, 0 continuing, 1 failed/);
    const [job] = await queuedFor(u);
    assert.equal(job?.attempts, 1);
    assert.match(job?.lastError ?? "", /fake deleteObjects failure/);
    assert.equal(job?.runAfter.getTime(), now().getTime() + 60_000, "retried in a minute");
    await outbox.drain();
    assert.ok(fake.objects.has(objectKeyFor(u, file.contentId!)), "not before its time");
    advanceMinutes(2);
    await outbox.drain();
    assert.equal(fake.objects.has(objectKeyFor(u, file.contentId!)), false);
    assert.deepEqual(await queuedFor(u), []);
  });

  await check("storage outage: a failing R2 call answers STORAGE_UNAVAILABLE and changes nothing", async () => {
    const upload = await start(me, { name: "flaky.bin", size: 8 });
    await sendBytes(me, upload);
    fake.failNext("headObject");
    await rejectsWith(uploads.complete(me, upload.id, undefined), "STORAGE_UNAVAILABLE");
    assert.equal((await uploads.get(me, upload.id)).state, "pending");
    await uploads.complete(me, upload.id, undefined);
    await audit(me);
  });

  await check("racing calls: two completes make one file; a cancel racing a complete can't both win", async () => {
    const upload = await start(me, { name: "race.bin", size: 11 });
    await sendBytes(me, upload);
    const before = await storedBytes(me);
    const [x, y] = await Promise.all([uploads.complete(me, upload.id, undefined), uploads.complete(me, upload.id, undefined)]);
    assert.equal(x.node!.id, y.node!.id);
    assert.equal(await storedBytes(me), before + 11n, "billed once");
    for (let i = 0; i < 5; i += 1) {
      const raced = await start(me, { name: `raced-${i}.bin`, size: 3 });
      await sendBytes(me, raced);
      const [completed, aborted] = await Promise.allSettled([uploads.complete(me, raced.id, undefined), uploads.abort(me, raced.id)]);
      const state = (await uploads.get(me, raced.id)).state;
      if (state === "completed") {
        assert.equal(completed.status, "fulfilled");
        if (aborted.status === "rejected") assert.equal((aborted.reason as { code?: string }).code, "UPLOAD_COMPLETED");
      } else {
        assert.equal(state, "aborted");
        assert.equal(completed.status, "rejected");
        assert.equal(aborted.status, "fulfilled");
      }
    }
    await audit(me);
  });

  await check("expiry: idle uploads expire and their bytes go at once; activity keeps one alive, up to 6 days", async () => {
    await uploads.expireStale(now()); // whatever earlier checks left idle
    await outbox.drain();
    const u = await newUser("expiry");
    const idle = await start(u, { name: "idle.bin", size: 17 * MiB });
    await sendBytes(u, idle, [2]);
    const busy = await start(u, { name: "busy.bin", size: 10 });
    advanceMinutes(20 * 60);
    assert.equal(await uploads.expireStale(now()), "expired 0 upload(s)");
    await uploads.get(u, busy.id); // activity slides its expiry
    advanceMinutes(20 * 60);
    assert.equal(await uploads.expireStale(now()), "expired 1 upload(s)");
    assert.deepEqual([(await uploads.get(u, idle.id)).state, (await uploads.get(u, busy.id)).state], ["expired", "pending"]);
    await outbox.drain();
    assert.deepEqual(fake.under(objectKeyFor(u, idle.id)), { objects: [], uploads: [] }, "cleaned up without the URL wait");
    // However busy, an upload ends UPLOAD_MAX_AGE_HOURS after it started.
    for (let hours = 60; hours <= UPLOAD_MAX_AGE_HOURS + 20; hours += 20) {
      advanceMinutes(20 * 60);
      await uploads.expireStale(now());
      const state = (await uploads.get(u, busy.id)).state; // a GET is activity too
      assert.equal(state, hours > UPLOAD_MAX_AGE_HOURS ? "expired" : "pending", `at ${hours} h`);
    }
  });

  await check("account deletion stops billing everything and sweeps every object the account had", async () => {
    const u = await newUser("leaving");
    await uploadFile(u, { name: "one.bin", size: 40 }, { thumbnail: true });
    await uploadFile(u, { name: "two.bin", size: 60 });
    const unfinished = await start(u, { name: "three.bin", size: 17 * MiB });
    await sendBytes(u, unfinished, [1]);
    const { googleSub } = await prisma.user.findUniqueOrThrow({ where: { id: u } });
    await account.deleteAccount(u, `${googleSub}|${Math.floor(now().getTime() / 1000)}`);
    assert.equal(await storedBytes(u), 0n);
    assert.deepEqual((await events(u)).slice(-1)[0], { deltaBytes: -100n, totalAfter: 0n, reason: "ACCOUNT_DELETE" });
    assert.equal(await prisma.blob.count({ where: { userId: u, purgedAt: null } }), 0);
    assert.equal(await prisma.uploadSession.count({ where: { userId: u } }), 0, "names in upload sessions are personal data too");
    const sweeps = (await queuedFor(u)).filter((job) => job.kind === "DELETE_PREFIX");
    assert.equal(sweeps.length, 4, "now, and again once every URL issued before has expired");
    await outbox.drain();
    assert.deepEqual([fake.under(`u/${u}/`), fake.under(`t/${u}/`)], [{ objects: [], uploads: [] }, { objects: [], uploads: [] }]);
    // Something uploaded on a URL handed out before the deletion is caught by the second sweep.
    fake.objects.set(objectKeyFor(u, randomUUID()), { size: 1, lastModified: new Date() });
    advanceMinutes(UPLOAD_CLEANUP_DELAY_SECONDS / 60 + 1);
    await outbox.drain();
    assert.deepEqual(fake.under(`u/${u}/`).objects, []);
    await audit(u);
  });

  await check("reconcile: garbage is queued, strays aborted, unknown and missing objects and drift are reported", async () => {
    const u = await newUser("reconcile");
    const keep = await uploadFile(u, { name: "keep.bin", size: 5 });
    const gone = await uploadFile(u, { name: "gone.bin", size: 6 });
    await tree.trash(u, gone.id);
    await tree.purge(u, gone.id);
    await outbox.drain();
    const mentions = (report: Awaited<ReturnType<typeof reconcile.inspect>>): string[] =>
      [...report.drifting, ...(report.bucket?.unknown ?? []), ...(report.bucket?.missing ?? [])].filter((item) => item.includes(u));
    assert.deepEqual(mentions(await reconcile.inspect(now())), [], "nothing to say about a clean account");

    fake.objects.set(objectKeyFor(u, gone.contentId!), { size: 6, lastModified: new Date() }); // a purged blob's object is back
    const unknownKey = objectKeyFor(u, randomUUID());
    fake.objects.set(unknownKey, { size: 1, lastModified: new Date() }); // a key no upload ever had
    const stray = await fake.createMultipartUpload(objectKeyFor(u, keep.contentId!)); // nothing waits for it
    const lost = await uploadFile(u, { name: "lost.bin", size: 8 });
    fake.objects.delete(objectKeyFor(u, lost.contentId!)); // data loss
    await prisma.user.update({ where: { id: u }, data: { storedBytes: { increment: 1 } } }); // drift

    const report = await reconcile.inspect(now());
    assert.ok(report.bucket!.unknown.includes(unknownKey), "reports the unknown key");
    assert.ok(report.bucket!.missing.includes(objectKeyFor(u, lost.contentId!)), "reports the missing object");
    assert.ok(report.drifting.includes(u), "reports the drifting account");
    assert.equal(fake.multipart.has(stray), false, "the stray upload is aborted");
    assert.match(await reconcile.run(now()), /^ALERT /, "the job's summary raises the alarm");
    assert.ok(fake.objects.has(objectKeyFor(u, keep.contentId!)), "live content untouched");
    await outbox.drain();
    assert.equal(fake.objects.has(objectKeyFor(u, gone.contentId!)), false, "garbage deleted");
    assert.ok(fake.objects.has(unknownKey), "unknown keys are only reported");
  });

  await check("scale: trashing and purging a 20,000-file folder stays linear, whatever the statistics say", async () => {
    // One huge folder skews the planner's statistics: the recursive query this replaced then
    // scanned the whole table once per folder on the frontier (5,000 files took 5 s, 70,000 never
    // finished). Level by level it is linear.
    const u = await newUser("scale");
    const box = await tree.createFolder(u, { id: randomUUID(), parentId: null, name: "Camera roll", onConflict: "fail" });
    const count = 20_000;
    const ids = Array.from({ length: count }, () => randomUUID());
    for (let i = 0; i < count; i += 5_000) {
      const chunk = ids.slice(i, i + 5_000);
      await prisma.blob.createMany({
        data: chunk.map((id) => ({ id, userId: u, bucket: fake.bucket, objectKey: objectKeyFor(u, id), size: 10n })),
      });
      await prisma.node.createMany({
        data: chunk.map((id, j) => ({
          id, userId: u, parentId: box.node.id, kind: "FILE" as const, name: `IMG_${i + j}.jpg`,
          nameKey: `img_${i + j}.jpg`, size: 10n, blobId: id, syncSeq: 1n,
        })),
      });
    }
    await prisma.user.update({ where: { id: u }, data: { storedBytes: BigInt(count * 10) } });
    await prisma.storageEvent.create({ data: { userId: u, at: now(), deltaBytes: BigInt(count * 10), totalAfter: BigInt(count * 10), reason: "ADMIN" } });
    await prisma.$executeRawUnsafe(`ANALYZE "Node"`);
    const started = Date.now();
    await tree.trash(u, box.node.id);
    await tree.purge(u, box.node.id);
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds < 20, `trash + purge took ${seconds}s`);
    assert.equal(await storedBytes(u), 0n);
    assert.equal((await queuedFor(u)).filter((job) => job.kind === "DELETE_OBJECTS").length, count / 1000);
  });

  await check("job: uploads.expire, outbox.drain and storage.reconcile are scheduled", async () => {
    const { JOBS } = await import("../modules/jobs/jobs");
    const names = JOBS.map((job) => `${job.name}:${job.everyMinutes ?? job.dailyAtIst}`);
    for (const expected of ["outbox.drain:1", "uploads.expire:15", "storage.reconcile:05:00"]) {
      assert.ok(names.includes(expected), `${expected} in ${names.join(", ")}`);
    }
  });

  await cleanup();
  console.log(`\ncheck:storage-db — ${passed} checks passed`);
};

void main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
