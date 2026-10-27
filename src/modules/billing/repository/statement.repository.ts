import { Prisma, Statement, StatementStatus } from "@prisma/client";
import { dateColumn, monthEnd, monthStart } from "../../../common/time";
import { prisma } from "../../../prisma/client";
import { byteMsToSeconds, PriceBookRow } from "../../metering/metering.rules";
import { BillTotals } from "../billing.rules";

// All Statement database access. A statement is made once per account and month, under the
// account's row lock, and never changed afterwards — except that a carried statement learns which
// later statement took its total (`carriedIntoId`).

export interface NewStatement {
  month: string;
  byteMs: bigint;
  billableByteMs: bigint;
  book: PriceBookRow;
  totals: BillTotals;
  status: "OPEN" | "CARRIED";
}

/** Statements inside an account's transaction (its row lock held). */
export class StatementTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string
  ) {}

  async latest(): Promise<Statement | null> {
    return this.tx.statement.findFirst({ where: { userId: this.userId }, orderBy: { periodStart: "desc" } });
  }

  /** The carried statement whose total hasn't gone into a later one yet. There is at most one. */
  async pendingCarry(): Promise<Statement | null> {
    return this.tx.statement.findFirst({ where: { userId: this.userId, status: StatementStatus.CARRIED, carriedIntoId: null } });
  }

  /**
   * The months after `after` (null: from the start) and before `before` whose closed days' charges
   * add up to at least `minMicroPaise`: the months still to bill, oldest first.
   */
  async monthsToBill(after: string | null, before: string, minMicroPaise: bigint): Promise<string[]> {
    const from = after === null ? null : dateColumn(monthEnd(after));
    const rows = await this.tx.$queryRaw<{ month: string }[]>`
      SELECT to_char(date_trunc('month', "day"), 'YYYY-MM') AS "month" FROM "UsageDay"
      WHERE "userId" = ${this.userId}::uuid AND "day" < ${monthStart(before)}::date
        AND (${from}::date IS NULL OR "day" > ${from}::date)
      GROUP BY 1
      HAVING SUM("chargeMicroPaise") >= ${minMicroPaise}
      ORDER BY 1`;
    return rows.map((row) => row.month);
  }

  async create(statement: NewStatement): Promise<Statement> {
    const { month, book, totals } = statement;
    return this.tx.statement.create({
      data: {
        userId: this.userId,
        periodStart: dateColumn(monthStart(month)),
        periodEnd: dateColumn(monthEnd(month)),
        byteSeconds: byteMsToSeconds(statement.byteMs),
        billableByteSeconds: byteMsToSeconds(statement.billableByteMs),
        priceBookId: book.id,
        storagePaisePerGbMonth: book.storagePaisePerGbMonth,
        gstBasisPoints: book.gstBasisPoints,
        minimumChargePaise: book.minimumChargePaise,
        subtotalPaise: totals.subtotalPaise,
        gstPaise: totals.gstPaise,
        carriedInPaise: totals.carriedInPaise,
        totalPaise: totals.totalPaise,
        status: statement.status,
      },
    });
  }

  /** Record that `carriedId`'s total went into `intoId`. */
  async markCarriedInto(carriedId: string, intoId: string): Promise<void> {
    await this.tx.statement.update({ where: { id: carriedId }, data: { carriedIntoId: intoId } });
  }
}

export class StatementRepository {
  /** The account's statements, newest first, before `beforeMonth` ("YYYY-MM") when paging. */
  async list(userId: string, beforeMonth: string | null, take: number): Promise<Statement[]> {
    return prisma.statement.findMany({
      where: { userId, ...(beforeMonth ? { periodStart: { lt: dateColumn(monthStart(beforeMonth)) } } : {}) },
      orderBy: { periodStart: "desc" },
      take,
    });
  }

  async findOwned(userId: string, id: string): Promise<Statement | null> {
    return prisma.statement.findFirst({ where: { id, userId } });
  }

  async latest(userId: string): Promise<Statement | null> {
    return prisma.statement.findFirst({ where: { userId }, orderBy: { periodStart: "desc" } });
  }

  /** The account's carried total still waiting for a statement to go into, if any. */
  async pendingCarry(userId: string): Promise<Statement | null> {
    return prisma.statement.findFirst({ where: { userId, status: StatementStatus.CARRIED, carriedIntoId: null } });
  }

  /**
   * Accounts with a month to bill before `currentMonth`: closed days after their newest statement
   * whose charges reach `minMicroPaise` in some month. Paged by id.
   */
  async accountsToBill(currentMonth: string, afterUserId: string | null, take: number, minMicroPaise: bigint): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "User" u
      LEFT JOIN LATERAL (
        SELECT s."periodEnd" FROM "Statement" s WHERE s."userId" = u."id" ORDER BY s."periodStart" DESC LIMIT 1
      ) last ON TRUE
      WHERE (${afterUserId}::uuid IS NULL OR u."id" > ${afterUserId}::uuid)
        AND EXISTS (
          SELECT 1 FROM "UsageDay" d
          WHERE d."userId" = u."id" AND d."day" < ${monthStart(currentMonth)}::date
            AND (last."periodEnd" IS NULL OR d."day" > last."periodEnd")
            AND d."chargeMicroPaise" > 0
          GROUP BY date_trunc('month', d."day")
          HAVING SUM(d."chargeMicroPaise") >= ${minMicroPaise}
        )
      ORDER BY u."id"
      LIMIT ${take}`;
    return rows.map((row) => row.id);
  }
}

export const statementRepository = new StatementRepository();
