// Integration checks for the file tree, the change feed and the worker's jobs against a real
// PostgreSQL — a LOCAL, disposable database only; the script refuses anything else:
//
//   npm run check:tree-db        (DATABASE_URL from .env, schema migrated)
//
// Runs the real TreeService / SyncService / job code with a clock the script moves forward. Prisma is
// used directly only for fixtures (users, file nodes without content), to inspect state,
// and to clean up what this run created.

import dotenv from "dotenv";
dotenv.config({ quiet: true });

let dbHost = "";
try {
  dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  dbHost = "";
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(dbHost)) {
  console.error("check:tree-db runs only against a LOCAL database (DATABASE_URL host must be localhost). Refusing.");
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
import { NodeKind } from "@prisma/client";
import { prisma } from "../prisma/client";
import { userRepository } from "../modules/account/repository/user.repository";
import { authService } from "../modules/auth/service/auth.service";
import { jobRunRepository } from "../modules/jobs/repository/jobRun.repository";
import { RETRY_AFTER_FAILURE_MS } from "../modules/jobs/jobs.schedule";
import { NodeDto } from "../modules/nodes/dto/node.dto";
import { TOMBSTONE_RETENTION_DAYS, TRASH_RETENTION_DAYS } from "../modules/nodes/nodes.policy";
import { TreeService } from "../modules/nodes/service/tree.service";
import { SyncService } from "../modules/sync/service/sync.service";

// ---------------------------------------------------------------- harness
let clock = new Date("2026-10-09T10:00:00Z");
const now = (): Date => clock;
const advanceDays = (days: number): void => {
  clock = new Date(clock.getTime() + days * 86_400_000);
};

const tree = new TreeService({ now });
const sync = new SyncService();

const RUN = Date.now().toString(36);
const createdUserIds = new Set<string>();
const newUser = async (label: string): Promise<string> => {
  const user = await prisma.user.create({ data: { googleSub: `check-${RUN}-${label}`, email: `${label}@example.test` } });
  createdUserIds.add(user.id);
  return user.id;
};

// Tree flows only need a file to exist, not its bytes: files are inserted directly (without content),
// stamped with a fresh sync sequence the way a tree change would be. Files made by uploads, with
// their storage accounting, are check:storage-db's.
const fixtureFile = async (userId: string, parentId: string | null, name: string): Promise<string> => {
  const { syncSeq } = await prisma.user.update({ where: { id: userId }, data: { syncSeq: { increment: 1 } } });
  const id = randomUUID();
  await prisma.node.create({
    data: { id, userId, parentId, kind: NodeKind.FILE, name, nameKey: name.toLowerCase(), size: 1000n, syncSeq },
  });
  return id;
};

const folder = async (userId: string, name: string, parentId: string | null = null): Promise<NodeDto> =>
  (await tree.createFolder(userId, { id: randomUUID(), parentId, name, onConflict: "fail" })).node;

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => {
    assert.equal((e as { code?: string }).code, code);
    return true;
  });
};

const names = (items: NodeDto[]): string[] => items.map((n) => n.name);

const cleanup = async (): Promise<void> => {
  const ids = [...createdUserIds];
  await prisma.node.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.jobRun.deleteMany({ where: { name: { startsWith: `check-${RUN}` } } });
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

  await check("create: new folder; the same id again is the same folder; someone else's id is a clash", async () => {
    const id = randomUUID();
    const first = await tree.createFolder(me, { id, parentId: null, name: "Documents", onConflict: "fail" });
    assert.equal(first.created, true);
    assert.equal(first.node.kind, "folder");
    const again = await tree.createFolder(me, { id, parentId: null, name: "Whatever", onConflict: "fail" });
    assert.deepEqual([again.created, again.node.name, again.node.id], [false, "Documents", id]);
    await rejectsWith(tree.createFolder(other, { id, parentId: null, name: "Mine", onConflict: "fail" }), "ID_CONFLICT");
  });

  await check("create: names are unique per folder ignoring case; rename numbers; bad parents refused", async () => {
    await folder(me, "Photos");
    await rejectsWith(tree.createFolder(me, { id: randomUUID(), parentId: null, name: "PHOTOS", onConflict: "fail" }), "NAME_CONFLICT");
    const numbered = await tree.createFolder(me, { id: randomUUID(), parentId: null, name: "photos", onConflict: "rename" });
    assert.equal(numbered.node.name, "photos (1)");
    await rejectsWith(tree.createFolder(me, { id: randomUUID(), parentId: randomUUID(), name: "x", onConflict: "fail" }), "NOT_FOUND");
    const othersFolder = await folder(other, "Theirs");
    await rejectsWith(tree.createFolder(me, { id: randomUUID(), parentId: othersFolder.id, name: "x", onConflict: "fail" }), "NOT_FOUND");
    await rejectsWith(tree.createFolder(me, { id: randomUUID(), parentId: null, name: "a/b", onConflict: "fail" }), "INVALID_NAME");
    // The same name in a different folder is fine.
    const docs = await folder(me, "Inner parent");
    await folder(me, "Photos", docs.id);
  });

  await check("list: folders first, each by name; paging crosses from folders to files cleanly", async () => {
    const box = await folder(me, "Listing");
    for (const n of ["beta", "Alpha", "gamma"]) await folder(me, n, box.id);
    for (const n of ["b.txt", "a.txt"]) await fixtureFile(me, box.id, n);

    const all = await tree.listChildren(me, box.id, undefined, undefined);
    assert.deepEqual(names(all.items), ["Alpha", "beta", "gamma", "a.txt", "b.txt"]);
    assert.equal(all.hasMore, false);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await tree.listChildren(me, box.id, cursor, "2");
      seen.push(...names(res.items));
      if (!res.hasMore) break;
      cursor = res.nextCursor ?? undefined;
    }
    assert.deepEqual(seen, ["Alpha", "beta", "gamma", "a.txt", "b.txt"]);
    // Exactly a page of folders, then files on the next page.
    const three = await tree.listChildren(me, box.id, undefined, "3");
    assert.deepEqual([names(three.items), three.hasMore], [["Alpha", "beta", "gamma"], true]);
    const rest = await tree.listChildren(me, box.id, three.nextCursor ?? undefined, "3");
    assert.deepEqual([names(rest.items), rest.hasMore], [["a.txt", "b.txt"], false]);

    await rejectsWith(tree.listChildren(other, box.id, undefined, undefined), "NOT_FOUND");
  });

  await check("rename and move: case-only rename, moves, cycles refused, name clash at the destination", async () => {
    const a = await folder(me, "MoveA");
    const b = await folder(me, "MoveB", a.id);
    const c = await folder(me, "MoveC", b.id);
    assert.equal((await tree.updateNode(me, a.id, { name: "MOVEA" })).name, "MOVEA");
    await rejectsWith(tree.updateNode(me, a.id, { parentId: c.id }), "MOVE_INTO_SELF");
    await rejectsWith(tree.updateNode(me, a.id, { parentId: a.id }), "MOVE_INTO_SELF");
    const moved = await tree.updateNode(me, c.id, { parentId: null });
    assert.equal(moved.parentId, null);
    await folder(me, "Clash", a.id);
    const clashing = await folder(me, "clash");
    await rejectsWith(tree.updateNode(me, clashing.id, { parentId: a.id }), "NAME_CONFLICT");
    await rejectsWith(tree.updateNode(me, a.id, {}), "BAD_REQUEST");
  });

  await check("ifSeq: a replayed edit against an older version is refused; the current one applies", async () => {
    const f = await folder(me, "Versioned");
    const renamed = await tree.updateNode(me, f.id, { name: "Versioned 2", ifSeq: f.syncSeq });
    assert.ok(renamed.syncSeq > f.syncSeq);
    await rejectsWith(tree.updateNode(me, f.id, { name: "Stale edit", ifSeq: f.syncSeq }), "NODE_CHANGED");
    assert.equal((await tree.getNode(me, f.id)).name, "Versioned 2");
  });

  await check("trash: the subtree goes as one batch; idempotent; the trash lists only what was trashed", async () => {
    const root = await folder(me, "TrashRoot");
    const child = await folder(me, "Child", root.id);
    const file = await fixtureFile(me, child.id, "inside.txt");
    const trashed = await tree.trash(me, root.id);
    assert.ok(trashed.trashedAt);
    for (const id of [child.id, file]) {
      const n = await tree.getNode(me, id);
      assert.deepEqual([Boolean(n.trashedAt), n.trashRootId], [true, root.id]);
    }
    assert.equal((await tree.trash(me, root.id)).trashedAt, trashed.trashedAt);
    const bin = await tree.listTrash(me, undefined, undefined);
    assert.ok(bin.items.some((n) => n.id === root.id));
    assert.ok(!bin.items.some((n) => n.id === child.id));
    // A trashed folder lists its trashed contents; nothing new can go inside it.
    assert.deepEqual(names((await tree.listChildren(me, root.id, undefined, undefined)).items), ["Child"]);
    await rejectsWith(tree.createFolder(me, { id: randomUUID(), parentId: root.id, name: "x", onConflict: "fail" }), "NODE_TRASHED");
    await rejectsWith(tree.updateNode(me, child.id, { name: "y" }), "NODE_TRASHED");
    // Its name is free again outside the trash.
    await folder(me, "TrashRoot");
  });

  await check("restore: back to its folder, or the root if that's gone; a clash is numbered; inner items refused", async () => {
    const parent = await folder(me, "RestoreParent");
    const item = await folder(me, "Item", parent.id);
    await tree.trash(me, item.id);
    assert.equal((await tree.restore(me, item.id)).parentId, parent.id);

    const inner = await folder(me, "Inner", item.id);
    await tree.trash(me, item.id);
    await rejectsWith(tree.restore(me, inner.id), "NOT_TRASH_ROOT");
    await tree.trash(me, parent.id); // its folder is now in the trash itself
    await folder(me, "Item"); // and the root already has an "Item"
    const back = await tree.restore(me, item.id);
    assert.deepEqual([back.parentId, back.name, back.trashedAt], [null, "Item (1)", null]);
    assert.equal((await tree.getNode(me, inner.id)).trashedAt, null, "restored with its batch");
    assert.ok((await tree.getNode(me, parent.id)).trashedAt, "the old parent stays trashed");
  });

  await check("purge: only from the trash; the subtree becomes nameless tombstones; idempotent", async () => {
    const doomed = await folder(me, "Doomed");
    const sub = await folder(me, "DoomedChild", doomed.id);
    await rejectsWith(tree.purge(me, doomed.id), "NOT_IN_TRASH");
    await tree.trash(me, doomed.id);
    await tree.purge(me, doomed.id);
    await tree.purge(me, doomed.id);
    await rejectsWith(tree.getNode(me, doomed.id), "NOT_FOUND");
    const row = await prisma.node.findUniqueOrThrow({ where: { id: sub.id } });
    assert.ok(row.deletedAt);
    assert.equal(row.name, "");
  });

  await check("empty trash: purges everything trashed, nothing else", async () => {
    const keep = await folder(me, "Keeper");
    const t1 = await folder(me, "Bin1");
    await folder(me, "Bin1Child", t1.id);
    await tree.trash(me, t1.id);
    const { purged } = await tree.emptyTrash(me);
    assert.ok(purged >= 2);
    assert.equal((await tree.listTrash(me, undefined, undefined)).items.length, 0);
    assert.equal((await tree.getNode(me, keep.id)).deletedAt, null);
  });

  await check("search: case-insensitive, outside the trash, wildcards taken literally, paged", async () => {
    const s = await newUser("search");
    await folder(s, "Holiday 2024");
    await folder(s, "holiday 2025");
    const gone = await folder(s, "Holiday trashed");
    await tree.trash(s, gone.id);
    await folder(s, "50% done");
    await folder(s, "500 files");
    await folder(s, "a_b");
    await folder(s, "axb");
    assert.deepEqual(names((await tree.search(s, "HOLIDAY", undefined, undefined)).items), ["Holiday 2024", "holiday 2025"]);
    assert.deepEqual(names((await tree.search(s, "50%", undefined, undefined)).items), ["50% done"]);
    assert.deepEqual(names((await tree.search(s, "a_b", undefined, undefined)).items), ["a_b"]);
    const first = await tree.search(s, "holiday", undefined, "1");
    const second = await tree.search(s, "holiday", first.nextCursor ?? undefined, "1");
    assert.deepEqual([names(first.items), names(second.items), second.hasMore], [["Holiday 2024"], ["holiday 2025"], false]);
    await rejectsWith(tree.search(s, "   ", undefined, undefined), "BAD_REQUEST");
  });

  await check("sync: full then incremental; a batch shares one seq and pages cleanly through ties", async () => {
    const u = await newUser("sync");
    const a = await folder(u, "SyncA");
    await folder(u, "SyncB");
    const full = await sync.changes(u, undefined, undefined);
    assert.deepEqual(names(full.changes), ["SyncA", "SyncB"]);
    assert.equal((await sync.changes(other, undefined, undefined)).changes.some((n) => n.id === a.id), false);

    // Nothing new: same cursor back, empty page.
    const idle = await sync.changes(u, full.nextCursor, undefined);
    assert.deepEqual([idle.changes.length, idle.nextCursor, idle.hasMore], [0, full.nextCursor, false]);

    for (const n of ["c1", "c2", "c3"]) await folder(u, n, a.id);
    await tree.trash(u, a.id); // one transaction: SyncA + 3 children share a seq
    const batchSeqs = new Set<number>();
    const seenIds: string[] = [];
    let cursor = full.nextCursor;
    for (let page = 0; page < 20; page += 1) {
      const res = await sync.changes(u, cursor, "1");
      for (const n of res.changes) {
        seenIds.push(n.id);
        if (n.trashedAt) batchSeqs.add(n.syncSeq);
      }
      cursor = res.nextCursor;
      if (!res.hasMore) break;
    }
    assert.equal(batchSeqs.size, 1, "a batch is one seq");
    // Each changed node appears once per change: 3 creates (stale now — re-sent as trashed) collapse to latest state.
    assert.equal(new Set(seenIds).size, 4);
  });

  await check("sync: compaction drops old tombstones and makes an older cursor resync (410)", async () => {
    const u = await newUser("compact");
    const x = await folder(u, "Ephemeral");
    const before = await sync.changes(u, undefined, undefined);
    await tree.trash(u, x.id);
    await tree.purge(u, x.id);
    advanceDays(TOMBSTONE_RETENTION_DAYS + 1);
    const summary = await sync.compactTombstones(now());
    assert.match(summary, /removed [1-9]/);
    assert.equal(await prisma.node.count({ where: { id: x.id } }), 0);
    await rejectsWith(sync.changes(u, before.nextCursor, undefined), "RESYNC_REQUIRED");
    const fresh = await sync.changes(u, undefined, undefined);
    assert.equal(fresh.changes.length, 0);
    const later = await sync.changes(u, fresh.nextCursor, undefined);
    assert.equal(later.changes.length, 0, "a cursor from after the resync is fine");
  });

  await check("sync: a full sync walking old rows below a raised floor never asks to resync", async () => {
    const u = await newUser("floorwalk");
    for (const n of ["Old1", "Old2", "Old3"]) await folder(u, n); // low sequence numbers
    const doomed = await folder(u, "Later");
    await tree.trash(u, doomed.id);
    await tree.purge(u, doomed.id); // the newest change is a tombstone…
    advanceDays(TOMBSTONE_RETENTION_DAYS + 1);
    await sync.compactTombstones(now()); // …so compaction raises the floor above Old1–3
    const floor = (await prisma.user.findUniqueOrThrow({ where: { id: u } })).syncFloor;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await sync.changes(u, cursor, "1"); // would 410 mid-way without the floor in the cursor
      seen.push(...names(res.changes));
      cursor = res.nextCursor;
      if (!res.hasMore) break;
    }
    assert.deepEqual(seen, ["Old1", "Old2", "Old3"]);
    const endSeq = BigInt(JSON.parse(Buffer.from(cursor!, "base64url").toString("utf8")).s);
    assert.ok(endSeq >= floor, "the finished pass ends at or past the floor");
    assert.equal((await sync.changes(u, cursor, undefined)).changes.length, 0);
  });

  await check("auto-purge job: trash older than the retention window is purged, newer trash is kept", async () => {
    const u = await newUser("autopurge");
    const old = await folder(u, "Old trash");
    await tree.trash(u, old.id);
    advanceDays(TRASH_RETENTION_DAYS - 1);
    const recent = await folder(u, "Recent trash");
    await tree.trash(u, recent.id);
    await tree.purgeExpiredTrash(now());
    assert.equal((await prisma.node.findUniqueOrThrow({ where: { id: old.id } })).deletedAt, null, "not yet");
    advanceDays(2);
    await tree.purgeExpiredTrash(now());
    assert.ok((await prisma.node.findUniqueOrThrow({ where: { id: old.id } })).deletedAt, "purged after the window");
    assert.equal((await prisma.node.findUniqueOrThrow({ where: { id: recent.id } })).deletedAt, null);
  });

  await check("concurrency: simultaneous creates of one name — exactly one wins, or all are numbered", async () => {
    const u = await newUser("race");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tree.createFolder(u, { id: randomUUID(), parentId: null, name: "Same", onConflict: "fail" }))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.every((r) => r.status === "fulfilled" || (r.reason as { code?: string }).code === "NAME_CONFLICT"));
    const renamed = await Promise.all(
      Array.from({ length: 4 }, () => tree.createFolder(u, { id: randomUUID(), parentId: null, name: "Same", onConflict: "rename" }))
    );
    assert.equal(new Set(renamed.map((r) => r.node.name.toLowerCase())).size, 4);
  });

  await check("account deletion removes the whole tree", async () => {
    const u = await newUser("deleted");
    const f = await folder(u, "Private");
    await folder(u, "Nested", f.id);
    await userRepository.anonymiseAndSignOut(u, now(), []);
    assert.equal(await prisma.node.count({ where: { userId: u } }), 0);
  });

  await check("jobs: one run per period; a failure is retried after the pause; expired sessions are removed", async () => {
    const job = `check-${RUN}-job`;
    const t = new Date("2026-10-10T00:00:00Z");
    assert.equal(await jobRunRepository.claim(job, "2026-10-10", t), true);
    assert.equal(await jobRunRepository.claim(job, "2026-10-10", t), false, "already running");
    await jobRunRepository.fail(job, "2026-10-10", t, "boom");
    assert.equal(await jobRunRepository.claim(job, "2026-10-10", new Date(t.getTime() + 60_000)), false, "cooling off");
    const later = new Date(t.getTime() + RETRY_AFTER_FAILURE_MS + 1000);
    assert.equal(await jobRunRepository.claim(job, "2026-10-10", later), true);
    await jobRunRepository.succeed(job, "2026-10-10", later, "done");
    assert.equal(await jobRunRepository.claim(job, "2026-10-10", later), false, "succeeded");
    assert.equal(await jobRunRepository.claim(job, "2026-10-11", later), true, "a new period");

    const u = await newUser("sessions");
    await prisma.session.create({
      data: { userId: u, refreshTokenHash: `check-${RUN}-expired`, expiresAt: new Date("2020-01-01T00:00:00Z") },
    });
    assert.match(await authService.purgeExpiredSessions(new Date()), /removed [1-9]/);
    assert.equal(await prisma.session.count({ where: { userId: u } }), 0);
  });

  await cleanup();
  console.log(`\ncheck:tree-db — ${passed} checks passed`);
};

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
