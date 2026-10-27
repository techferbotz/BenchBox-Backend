import { Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { lockUserRow } from "../../../prisma/sql";
import { MeterTx } from "../../metering/repository/metering.repository";
import { NotificationTx } from "../../notifications/repository/notification.repository";
import { StatementTx } from "./statement.repository";

// Billing's database access beyond statements: the account's monthly limit, and the transaction a
// statement is made in — the account's row lock, its metering, its statements and the
// notification that announces a bill, all committing together.

/** One account's billing, inside a transaction holding its row lock. */
export class BillingTx {
  readonly meter: MeterTx;
  readonly statements: StatementTx;
  readonly notifications: NotificationTx;

  constructor(
    tx: Prisma.TransactionClient,
    readonly userId: string,
    /** The account as the lock found it; a deleted account still gets its statements. */
    readonly account: { deletedAt: Date | null },
    now: Date
  ) {
    this.meter = new MeterTx(tx, userId);
    this.statements = new StatementTx(tx, userId);
    this.notifications = new NotificationTx(tx, userId, now);
  }
}

export interface LimitRow {
  userId: string;
  limitPaise: bigint;
}

export class BillingRepository {
  async inAccountLock<T>(userId: string, now: Date, fn: (billing: BillingTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        const account = await lockUserRow(tx, userId);
        if (!account) throw new Error(`No account ${userId}`);
        return fn(new BillingTx(tx, userId, account, now));
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  }

  /** The account's monthly limit in paise, or null without one. */
  async limitOf(userId: string): Promise<bigint | null> {
    const row = await prisma.billingAccount.findUnique({ where: { userId }, select: { monthlyLimitPaise: true } });
    return row?.monthlyLimitPaise ?? null;
  }

  /** Live accounts with a monthly limit, paged by id: the ones usage alerts are for. */
  async accountsWithLimit(afterUserId: string | null, take: number): Promise<LimitRow[]> {
    const rows = await prisma.billingAccount.findMany({
      where: {
        monthlyLimitPaise: { not: null },
        user: { deletedAt: null },
        ...(afterUserId ? { userId: { gt: afterUserId } } : {}),
      },
      orderBy: { userId: "asc" },
      take,
      select: { userId: true, monthlyLimitPaise: true },
    });
    return rows.flatMap((row) => (row.monthlyLimitPaise === null ? [] : [{ userId: row.userId, limitPaise: row.monthlyLimitPaise }]));
  }
}

export const billingRepository = new BillingRepository();
