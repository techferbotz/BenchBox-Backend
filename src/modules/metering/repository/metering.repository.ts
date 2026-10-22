import { NodeKind, Prisma, UploadState } from "@prisma/client";
import { prisma } from "../../../prisma/client";

// Metering's database access. Bills (P4) are computed from the StorageEvent log, so this file owns
// the one function allowed to change how many bytes a user stores.

export type StorageChangeReason = "UPLOAD" | "REPLACE" | "PURGE" | "ACCOUNT_DELETE" | "ADMIN";

/** Metering inside an open transaction. */
export class MeteringTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
    private readonly now: Date
  ) {}

  /**
   * THE choke point (docs/BACKEND_PLAN.md §1, rule 2): every change to a user's stored bytes comes
   * through here, inside the transaction that makes the change — uploads, replacements, purges,
   * account deletion. It moves User.storedBytes and appends a StorageEvent with the new total.
   *
   * The UPDATE takes the user's row lock and holds it to commit, so for one user the events' ids
   * follow commit order and each `totalAfter` is exact. `at` is the caller's clock reading, which
   * can trail the lock wait by a moment; the daily close (P4) orders by id and treats `at` as never
   * running backwards. Returns the new total; a zero delta records nothing.
   */
  async recordStorageChange(deltaBytes: bigint, reason: StorageChangeReason, refId: string | null): Promise<bigint | null> {
    if (deltaBytes === 0n) return null;
    const { storedBytes } = await this.tx.user.update({
      where: { id: this.userId },
      data: { storedBytes: { increment: deltaBytes } },
      select: { storedBytes: true },
    });
    if (storedBytes < 0n) {
      // A bug, never a state to store: throwing rolls the whole transaction back.
      throw new Error(`Stored bytes for user ${this.userId} would become ${storedBytes}`);
    }
    await this.tx.storageEvent.create({
      data: { userId: this.userId, at: this.now, deltaBytes, totalAfter: storedBytes, reason, refId },
    });
    return storedBytes;
  }
}

export interface StorageUsageRow {
  storedBytes: bigint;
  trashBytes: bigint;
  reservedBytes: bigint;
}

export interface AccountingRow {
  userId: string;
  storedBytes: bigint;
  blobBytes: bigint;
  lastTotal: bigint | null;
}

export class MeteringRepository {
  /** What an account stores, how much of it is in the trash, and what unfinished uploads reserve. */
  async usage(userId: string): Promise<StorageUsageRow | null> {
    const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { storedBytes: true } });
    if (!user) return null;
    const [trash, reserved] = await Promise.all([
      prisma.node.aggregate({
        where: { userId, kind: NodeKind.FILE, trashedAt: { not: null }, deletedAt: null },
        _sum: { size: true },
      }),
      prisma.uploadSession.aggregate({ where: { userId, state: UploadState.PENDING }, _sum: { declaredSize: true } }),
    ]);
    return {
      storedBytes: user.storedBytes,
      trashBytes: trash._sum.size ?? 0n,
      reservedBytes: reserved._sum.declaredSize ?? 0n,
    };
  }

  /**
   * Per account: the stored-bytes counter, the sum of its unpurged blobs, and the newest event's
   * total. All three must agree — the reconciliation job reports any account where they don't.
   */
  async accounting(): Promise<AccountingRow[]> {
    return prisma.$queryRaw<AccountingRow[]>`
      SELECT u."id" AS "userId", u."storedBytes",
        COALESCE((SELECT SUM(b."size") FROM "Blob" b WHERE b."userId" = u."id" AND b."purgedAt" IS NULL), 0)::bigint AS "blobBytes",
        (SELECT e."totalAfter" FROM "StorageEvent" e WHERE e."userId" = u."id" ORDER BY e."id" DESC LIMIT 1) AS "lastTotal"
      FROM "User" u
      WHERE u."storedBytes" <> 0
         OR EXISTS (SELECT 1 FROM "Blob" b WHERE b."userId" = u."id" AND b."purgedAt" IS NULL)
         OR EXISTS (SELECT 1 FROM "StorageEvent" e WHERE e."userId" = u."id")`;
  }

  /**
   * Links that must hold: every unpurged blob belongs to exactly one live node, and every live file
   * has an unpurged blob. Counts of the rows breaking either rule.
   */
  async brokenLinks(): Promise<{ orphanBlobs: number; filesWithoutContent: number }> {
    const [row] = await prisma.$queryRaw<{ orphanBlobs: bigint; filesWithoutContent: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM "Blob" b WHERE b."purgedAt" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "Node" n WHERE n."blobId" = b."id" AND n."deletedAt" IS NULL)) AS "orphanBlobs",
        (SELECT COUNT(*) FROM "Node" n WHERE n."kind" = 'FILE' AND n."deletedAt" IS NULL
           AND (n."blobId" IS NULL OR EXISTS (SELECT 1 FROM "Blob" b WHERE b."id" = n."blobId" AND b."purgedAt" IS NOT NULL))) AS "filesWithoutContent"`;
    return { orphanBlobs: Number(row?.orphanBlobs ?? 0n), filesWithoutContent: Number(row?.filesWithoutContent ?? 0n) };
  }
}

export const meteringRepository = new MeteringRepository();
