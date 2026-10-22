import { Node, NodeKind, Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { lockUserRow, utc } from "../../../prisma/sql";
import { BlobTx } from "../../files/repository/blob.repository";
import { UploadSessionTx } from "../../files/repository/upload.repository";
import { MeteringTx, StorageChangeReason } from "../../metering/repository/metering.repository";
import { deleteObjectsJobs } from "../../outbox/outbox.jobs";
import { OutboxTx } from "../../outbox/repository/outbox.repository";
import { escapeLike, NameCursor, SyncCursor, TrashCursor } from "../nodes.rules";

// All Node database access (no Prisma outside repositories, HOA protocol 04). Every WRITE goes
// through a transaction that holds the user's row lock — that lock is what makes the sibling-name
// check race-free, keeps sync sequence numbers in commit order, and keeps the stored-bytes counter
// and its event log exact.
//
// Tree walks stop at depth 10000: the service never lets a cycle form, but a walk must not loop
// forever if bad data ever slipped in.

/** Which children a folder listing shows: an active folder's active children, or a trashed one's. */
export type ChildState = "active" | "trashed";

/**
 * One user's data, as a transaction holding that user's row lock sees it: node reads, plus the
 * user's upload sessions, blobs, metering and outbox — every table a tree or storage change touches,
 * joined in one transaction. Changing NODES needs a sync sequence: that is TreeTx.
 */
export class UserTx {
  readonly uploads: UploadSessionTx;
  readonly blobs: BlobTx;
  readonly metering: MeteringTx;
  readonly outbox: OutboxTx;

  constructor(
    protected readonly tx: Prisma.TransactionClient,
    readonly userId: string,
    readonly now: Date
  ) {
    this.uploads = new UploadSessionTx(tx, userId, now);
    this.blobs = new BlobTx(tx, userId, now);
    this.metering = new MeteringTx(tx, userId, now);
    this.outbox = new OutboxTx(tx);
  }

  /** A node with this id, whoever owns it — ids come from the app, so a clash must be noticed. */
  async findById(id: string): Promise<Node | null> {
    return this.tx.node.findUnique({ where: { id } });
  }

  async findOwned(id: string): Promise<Node | null> {
    return this.tx.node.findFirst({ where: { id, userId: this.userId } });
  }

  async isNameTaken(parentId: string | null, nameKey: string, exceptId?: string): Promise<boolean> {
    const clash = await this.tx.node.findFirst({
      where: {
        userId: this.userId,
        parentId,
        nameKey,
        trashedAt: null,
        deletedAt: null,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    return clash !== null;
  }

  /** The active node in `parentId` whose name has this key, if any. */
  async findActiveSibling(parentId: string | null, nameKey: string): Promise<Node | null> {
    return this.tx.node.findFirst({ where: { userId: this.userId, parentId, nameKey, trashedAt: null, deletedAt: null } });
  }

  /** Active sibling keys starting with `prefix`: the taken set for choosing "name (n)". */
  async siblingKeysWithPrefix(parentId: string | null, prefix: string): Promise<Set<string>> {
    const rows = await this.tx.node.findMany({
      where: { userId: this.userId, parentId, trashedAt: null, deletedAt: null, nameKey: { startsWith: escapeLike(prefix) } },
      select: { nameKey: true },
    });
    return new Set(rows.map((row) => row.nameKey));
  }

  /** True if putting `nodeId` under `newParentId` would make a cycle (the parent is it, or inside it). */
  async wouldCreateCycle(nodeId: string, newParentId: string): Promise<boolean> {
    const rows = await this.tx.$queryRaw<{ hit: boolean }[]>`
      WITH RECURSIVE up AS (
        SELECT "id", "parentId", 1 AS depth FROM "Node"
        WHERE "id" = ${newParentId}::uuid AND "userId" = ${this.userId}::uuid
        UNION ALL
        SELECT n."id", n."parentId", up.depth + 1 FROM "Node" n
        JOIN up ON n."id" = up."parentId"
        WHERE n."userId" = ${this.userId}::uuid AND up.depth < 10000
      )
      SELECT EXISTS (SELECT 1 FROM up WHERE "id" = ${nodeId}::uuid) AS hit`;
    return rows[0]?.hit === true;
  }
}

/** File content, as a completed upload hands it to a file node. */
export interface FileContent {
  size: bigint;
  mimeType: string;
  blobId: string;
  hasThumbnail: boolean;
}

/** UserTx that may change nodes: `seq`, the user's next sync sequence, stamps every node it changes. */
export class TreeTx extends UserTx {
  constructor(
    tx: Prisma.TransactionClient,
    userId: string,
    readonly seq: bigint,
    now: Date
  ) {
    super(tx, userId, now);
  }

  async createFolder(data: { id: string; parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    return this.tx.node.create({
      data: {
        ...data,
        userId: this.userId,
        kind: NodeKind.FOLDER,
        syncSeq: this.seq,
        createdAt: this.now,
        updatedAt: this.now,
      },
    });
  }

  async createFile(data: { id: string; parentId: string | null; name: string; nameKey: string } & FileContent): Promise<Node> {
    return this.tx.node.create({
      data: {
        ...data,
        userId: this.userId,
        kind: NodeKind.FILE,
        syncSeq: this.seq,
        createdAt: this.now,
        updatedAt: this.now,
      },
    });
  }

  /** Give an existing file new content. Its old blob is the caller's to release (releaseContent). */
  async replaceContent(id: string, content: FileContent): Promise<Node> {
    return this.tx.node.update({ where: { id }, data: { ...content, syncSeq: this.seq, updatedAt: this.now } });
  }

  /** Rename and/or move one node. */
  async place(id: string, data: { parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    return this.tx.node.update({ where: { id }, data: { ...data, syncSeq: this.seq, updatedAt: this.now } });
  }

  /**
   * `rootId` and every unpurged node under it, one tree level per query (`parentId = ANY(level)`,
   * on the parentId index). A recursive CTE was tried first: its per-folder lookup is planned
   * once, from table statistics, and when one huge folder dominates them the planner scanned the
   * whole table for every folder on the frontier — a 70,000-file folder took minutes. Level by
   * level, the cost stays linear in the subtree however the planner chooses.
   */
  private async subtreeIds(rootId: string): Promise<string[]> {
    const seen = new Set([rootId]);
    let level = [rootId];
    for (let depth = 0; level.length > 0 && depth < 10000; depth += 1) {
      const children = await this.tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Node"
        WHERE "parentId" = ANY(${level}::uuid[]) AND "userId" = ${this.userId}::uuid AND "deletedAt" IS NULL`;
      level = children.map((child) => child.id).filter((id) => !seen.has(id));
      level.forEach((id) => seen.add(id));
    }
    return [...seen];
  }

  /** Trash `rootId` and every active node under it, as one batch. Returns the number trashed. */
  async trashSubtree(rootId: string): Promise<number> {
    const ids = await this.subtreeIds(rootId);
    return this.tx.$executeRaw`
      UPDATE "Node"
      SET "trashedAt" = ${utc(this.now)}, "trashRootId" = ${rootId}::uuid,
          "syncSeq" = ${this.seq}, "updatedAt" = ${utc(this.now)}
      WHERE "id" = ANY(${ids}::uuid[]) AND "userId" = ${this.userId}::uuid
        AND "trashedAt" IS NULL AND "deletedAt" IS NULL`;
  }

  /** Bring back the batch trashed with `rootId`, putting the root where the service decided. */
  async restoreBatch(rootId: string, placement: { parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    await this.tx.node.updateMany({
      where: { userId: this.userId, trashRootId: rootId, deletedAt: null },
      data: { trashedAt: null, trashRootId: null, syncSeq: this.seq, updatedAt: this.now },
    });
    return this.tx.node.update({
      where: { id: rootId },
      data: { ...placement, syncSeq: this.seq, updatedAt: this.now },
    });
  }

  /**
   * Stop billing these blobs and queue their objects' deletion — in this transaction, so the bytes
   * stop counting at the moment the nodes stop pointing at them, and the deletion can't be lost.
   * Blobs already purged are skipped. Returns the bytes released.
   */
  async releaseContent(blobIds: readonly string[], reason: StorageChangeReason, refId: string | null): Promise<bigint> {
    const purged = await this.blobs.purge(blobIds);
    if (purged.length === 0) return 0n;
    const bytes = purged.reduce((sum, blob) => sum + blob.size, 0n);
    await this.metering.recordStorageChange(-bytes, reason, refId);
    const keys = purged.flatMap((blob) => (blob.thumbKey ? [blob.objectKey, blob.thumbKey] : [blob.objectKey]));
    await this.outbox.enqueue(deleteObjectsJobs(keys, this.now));
    return bytes;
  }

  // A purged node keeps only what the change feed needs to announce the delete: its name is cleared.
  // Its blob link stays as the record of what it held; the blob itself is released.
  private purgeSet(): Prisma.Sql {
    return Prisma.sql`"deletedAt" = ${utc(this.now)}, "name" = '', "nameKey" = '', "mimeType" = NULL,
      "hasThumbnail" = false, "syncSeq" = ${this.seq}, "updatedAt" = ${utc(this.now)}`;
  }

  private async releasePurged(rows: { blobId: string | null }[], refId: string | null): Promise<number> {
    const blobIds = rows.flatMap((row) => (row.blobId ? [row.blobId] : []));
    await this.releaseContent(blobIds, "PURGE", refId);
    return rows.length;
  }

  /** Purge `rootId` and everything under it, trashed or not. Returns the number purged. */
  async purgeSubtree(rootId: string): Promise<number> {
    const ids = await this.subtreeIds(rootId);
    const rows = await this.tx.$queryRaw<{ blobId: string | null }[]>`
      UPDATE "Node" SET ${this.purgeSet()}
      WHERE "id" = ANY(${ids}::uuid[]) AND "userId" = ${this.userId}::uuid AND "deletedAt" IS NULL
      RETURNING "blobId"`;
    return this.releasePurged(rows, rootId);
  }

  /** Empty the trash. Everything under a trashed node is trashed too, so this covers whole subtrees. */
  async purgeAllTrashed(): Promise<number> {
    const rows = await this.tx.$queryRaw<{ blobId: string | null }[]>`
      UPDATE "Node" SET ${this.purgeSet()}
      WHERE "userId" = ${this.userId}::uuid AND "trashedAt" IS NOT NULL AND "deletedAt" IS NULL
      RETURNING "blobId"`;
    return this.releasePurged(rows, null);
  }

  /**
   * Purge what has been in the trash since before `cutoff`. Every node of a batch shares its
   * `trashedAt`, and a batch nested inside an older one is older still, so a plain time filter
   * takes whole subtrees.
   */
  async purgeTrashedBefore(cutoff: Date): Promise<number> {
    const rows = await this.tx.$queryRaw<{ blobId: string | null }[]>`
      UPDATE "Node" SET ${this.purgeSet()}
      WHERE "userId" = ${this.userId}::uuid AND "trashedAt" < ${utc(cutoff)} AND "deletedAt" IS NULL
      RETURNING "blobId"`;
    return this.releasePurged(rows, null);
  }
}

const nameOrder = [{ nameKey: "asc" as const }, { id: "asc" as const }];

const afterName = (after: NameCursor | null) =>
  after ? { OR: [{ nameKey: { gt: after.nameKey } }, { nameKey: after.nameKey, id: { gt: after.id } }] } : {};

export class TreeRepository {
  /**
   * Run `fn` in a transaction that first takes the user's row lock and allocates the next sync
   * sequence. Every tree change for this user is serialised by that lock, and the sequence numbers
   * the changes in commit order — which is what lets the change feed promise it never skips one.
   */
  async inUserTransaction<T>(userId: string, now: Date, fn: (tree: TreeTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        const { syncSeq } = await tx.user.update({
          where: { id: userId },
          data: { syncSeq: { increment: 1 } },
          select: { syncSeq: true },
        });
        return fn(new TreeTx(tx, userId, syncSeq, now));
      },
      // Trashing then purging a 70,000-file folder takes about 10 s (check:storage-db pins 20,000);
      // two minutes leaves room for far bigger trees.
      { maxWait: 10_000, timeout: 120_000 }
    );
  }

  /**
   * Run `fn` holding the user's row lock but WITHOUT a sync sequence: for work that is serialised
   * with the user's tree and storage changes but changes no node (starting an upload checks the
   * storage allowance and reserves its share). `account` is null when there is no such user.
   */
  async inUserLock<T>(
    userId: string,
    now: Date,
    fn: (user: UserTx, account: { deletedAt: Date | null; storedBytes: bigint } | null) => Promise<T>
  ): Promise<T> {
    return prisma.$transaction(
      async (tx) => fn(new UserTx(tx, userId, now), await lockUserRow(tx, userId)),
      { maxWait: 10_000, timeout: 30_000 }
    );
  }

  async findOwned(userId: string, id: string): Promise<Node | null> {
    return prisma.node.findFirst({ where: { id, userId } });
  }

  /** One kind of a folder's children (the root when `parentId` is null), by name. */
  async listChildrenOfKind(
    userId: string,
    parentId: string | null,
    kind: NodeKind,
    state: ChildState,
    after: NameCursor | null,
    take: number
  ): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        parentId,
        kind,
        deletedAt: null,
        trashedAt: state === "active" ? null : { not: null },
        ...afterName(after),
      },
      orderBy: nameOrder,
      take,
    });
  }

  /** What the user put in the trash (batch roots only), most recent first. */
  async listTrashRoots(userId: string, after: TrashCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        deletedAt: null,
        trashedAt: { not: null },
        trashRootId: { equals: prisma.node.fields.id },
        ...(after
          ? { OR: [{ trashedAt: { lt: after.trashedAt } }, { trashedAt: after.trashedAt, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ trashedAt: "desc" }, { id: "desc" }],
      take,
    });
  }

  /** Active nodes whose name contains `fragment` (already a name key), by name. */
  async search(userId: string, fragment: string, after: NameCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: { userId, trashedAt: null, deletedAt: null, nameKey: { contains: escapeLike(fragment) }, ...afterName(after) },
      orderBy: nameOrder,
      take,
    });
  }

  /** Every node changed after `after`, in (syncSeq, id) order — tombstones included. */
  async changesSince(userId: string, after: SyncCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        ...(after
          ? { OR: [{ syncSeq: { gt: after.seq } }, { syncSeq: after.seq, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ syncSeq: "asc" }, { id: "asc" }],
      take,
    });
  }

  async syncState(userId: string): Promise<{ syncSeq: bigint; syncFloor: bigint } | null> {
    return prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { syncSeq: true, syncFloor: true } });
  }

  // ---------------------------------------------------------------- jobs

  async usersWithTrashBefore(cutoff: Date, take: number): Promise<string[]> {
    const rows = await prisma.node.findMany({
      where: { trashedAt: { lt: cutoff }, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"],
      take,
    });
    return rows.map((row) => row.userId);
  }

  async usersWithTombstonesBefore(cutoff: Date, take: number): Promise<string[]> {
    const rows = await prisma.node.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { userId: true },
      distinct: ["userId"],
      take,
    });
    return rows.map((row) => row.userId);
  }

  /**
   * Delete the user's tombstones purged before `cutoff`, raising `syncFloor` past them, so a device
   * whose cursor predates them is told to resync rather than silently missing those deletes. A
   * parent is never purged earlier than its children, so whole subtrees go together.
   */
  async compactTombstones(userId: string, cutoff: Date): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { syncSeq: { increment: 0 } }, // takes the row lock: no tree change interleaves
        select: { syncFloor: true },
      });
      const { _max } = await tx.node.aggregate({ where: { userId, deletedAt: { lt: cutoff } }, _max: { syncSeq: true } });
      if (_max.syncSeq === null) return 0;
      const { count } = await tx.node.deleteMany({ where: { userId, deletedAt: { lt: cutoff } } });
      if (_max.syncSeq > user.syncFloor) {
        await tx.user.update({ where: { id: userId }, data: { syncFloor: _max.syncSeq } });
      }
      return count;
    });
  }
}

export const treeRepository = new TreeRepository();
