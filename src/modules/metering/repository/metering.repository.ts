import { NodeKind, PriceBook, Prisma, UploadState } from "@prisma/client";
import { dateColumn, fromDateColumn } from "../../../common/time";
import { prisma } from "../../../prisma/client";
import { lockUserRow } from "../../../prisma/sql";
import { byteMsToSeconds, MeterEvent, PriceBookRow, secondsToByteMs } from "../metering.rules";

// Metering's database access. Bills are computed from the StorageEvent log, so this file owns the
// one function allowed to change how many bytes a user stores, and the daily close that turns the
// log into UsageDays.

export type StorageChangeReason = "UPLOAD" | "REPLACE" | "PURGE" | "ACCOUNT_DELETE" | "ADMIN";

/** A closed day (UsageDay), with byte-seconds as exact byte-milliseconds. */
export interface UsageDayRow {
  day: string;
  byteMs: bigint;
  billableByteMs: bigint;
  peakBytes: bigint;
  endBytes: bigint;
  lastEventId: bigint;
  chargeMicroPaise: bigint;
  priceBookId: string;
}

type UsageDayRecord = {
  day: Date;
  byteSeconds: Prisma.Decimal;
  billableByteSeconds: Prisma.Decimal;
  peakBytes: bigint;
  endBytes: bigint;
  lastEventId: bigint;
  chargeMicroPaise: bigint;
  priceBookId: string;
};

const toUsageDayRow = (row: UsageDayRecord): UsageDayRow => ({
  day: fromDateColumn(row.day),
  byteMs: secondsToByteMs(row.byteSeconds.toFixed(3)),
  billableByteMs: secondsToByteMs(row.billableByteSeconds.toFixed(3)),
  peakBytes: row.peakBytes,
  endBytes: row.endBytes,
  lastEventId: row.lastEventId,
  chargeMicroPaise: row.chargeMicroPaise,
  priceBookId: row.priceBookId,
});

const toPriceBookRow = (book: PriceBook): PriceBookRow => ({
  id: book.id,
  effectiveFrom: fromDateColumn(book.effectiveFrom),
  storagePaisePerGbMonth: book.storagePaisePerGbMonth,
  freeBytes: book.freeBytes,
  gstBasisPoints: book.gstBasisPoints,
  minimumChargePaise: book.minimumChargePaise,
  createdAt: book.createdAt,
});

const eventsAfter = async (db: Prisma.TransactionClient, userId: string, afterId: bigint, take: number): Promise<MeterEvent[]> =>
  db.storageEvent.findMany({
    where: { userId, id: { gt: afterId } },
    orderBy: { id: "asc" },
    take,
    select: { id: true, at: true, totalAfter: true },
  });

/** The daily close for one account, inside a transaction holding its row lock. */
export class MeterTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    readonly userId: string
  ) {}

  /** The account's newest closed day: where the next close resumes. */
  async lastDay(): Promise<UsageDayRow | null> {
    const row = await this.tx.usageDay.findFirst({ where: { userId: this.userId }, orderBy: { day: "desc" } });
    return row ? toUsageDayRow(row) : null;
  }

  /** The account's StorageEvents after `afterId`, in id (commit) order. */
  async eventsAfter(afterId: bigint, take: number): Promise<MeterEvent[]> {
    return eventsAfter(this.tx, this.userId, afterId, take);
  }

  async addDays(rows: readonly UsageDayRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx.usageDay.createMany({
      data: rows.map((row) => ({
        userId: this.userId,
        day: dateColumn(row.day),
        byteSeconds: byteMsToSeconds(row.byteMs),
        billableByteSeconds: byteMsToSeconds(row.billableByteMs),
        peakBytes: row.peakBytes,
        endBytes: row.endBytes,
        lastEventId: row.lastEventId,
        chargeMicroPaise: row.chargeMicroPaise,
        priceBookId: row.priceBookId,
      })),
    });
  }

  /** The closed days from `from` to `to`, inclusive, oldest first. */
  async daysBetween(from: string, to: string): Promise<UsageDayRow[]> {
    const rows = await this.tx.usageDay.findMany({
      where: { userId: this.userId, day: { gte: dateColumn(from), lte: dateColumn(to) } },
      orderBy: { day: "asc" },
    });
    return rows.map(toUsageDayRow);
  }
}

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
  /** Every price book (a handful of rows), for priceBookFor() to choose from. */
  async priceBooks(): Promise<PriceBookRow[]> {
    const books = await prisma.priceBook.findMany({ orderBy: { effectiveFrom: "asc" } });
    return books.map(toPriceBookRow);
  }

  /**
   * Run `fn` holding the account's row lock: one account's close is serialised with its storage
   * changes and with any other close. Null-safe for a deleted account (its row stays).
   */
  async inAccountLock<T>(userId: string, fn: (meter: MeterTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        await lockUserRow(tx, userId);
        return fn(new MeterTx(tx, userId));
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  }

  /**
   * Accounts with days to close through `through`: something still stored after their newest
   * closed day, or storage events it hasn't taken in. Paged by id.
   */
  async accountsToClose(through: string, afterUserId: string | null, take: number): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "User" u
      LEFT JOIN LATERAL (
        SELECT d."day", d."endBytes", d."lastEventId" FROM "UsageDay" d
        WHERE d."userId" = u."id" ORDER BY d."day" DESC LIMIT 1
      ) last ON TRUE
      WHERE (${afterUserId}::uuid IS NULL OR u."id" > ${afterUserId}::uuid)
        AND (last."day" IS NULL OR last."day" < ${through}::date)
        AND (COALESCE(last."endBytes", 0) > 0
          OR EXISTS (SELECT 1 FROM "StorageEvent" e
                     WHERE e."userId" = u."id" AND e."id" > COALESCE(last."lastEventId", 0)))
      ORDER BY u."id"
      LIMIT ${take}`;
    return rows.map((row) => row.id);
  }

  /**
   * The account's closed days from `from` on, and its newest closed day (from any month), read in
   * ONE statement: a close committing meanwhile can't make the two disagree.
   */
  async closedDaysSince(userId: string, from: string): Promise<{ days: UsageDayRow[]; last: UsageDayRow | null }> {
    const rows = await prisma.$queryRaw<UsageDayRecord[]>`
      SELECT "day", "byteSeconds", "billableByteSeconds", "peakBytes", "endBytes", "lastEventId", "chargeMicroPaise", "priceBookId"
      FROM "UsageDay"
      WHERE "userId" = ${userId}::uuid
        AND ("day" >= ${from}::date OR "day" = (SELECT MAX("day") FROM "UsageDay" WHERE "userId" = ${userId}::uuid))
      ORDER BY "day"`;
    const days = rows.map(toUsageDayRow);
    return { days: days.filter((day) => day.day >= from), last: days[days.length - 1] ?? null };
  }

  /** The account's StorageEvents after `afterId`, in id (commit) order. */
  async eventsAfter(userId: string, afterId: bigint, take: number): Promise<MeterEvent[]> {
    return eventsAfter(prisma, userId, afterId, take);
  }

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
