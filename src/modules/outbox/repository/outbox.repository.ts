import { Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { utc } from "../../../prisma/sql";
import { OutboxJobInput } from "../outbox.jobs";

// All OutboxJob database access. Jobs are queued inside the transaction that needs them (OutboxTx),
// so a committed change always has its follow-up work recorded; the drain claims them with
// SKIP LOCKED and a lease, so two drains never run the same job at once and a crashed one's jobs
// come back after the lease.

const toRows = (jobs: readonly OutboxJobInput[]) =>
  jobs.map((job) => ({ kind: job.kind, payload: job.payload as Prisma.InputJsonObject, runAfter: job.runAfter }));

/** Queues jobs inside an open transaction. */
export class OutboxTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async enqueue(jobs: readonly OutboxJobInput[]): Promise<void> {
    if (jobs.length > 0) await this.tx.outboxJob.createMany({ data: toRows(jobs) });
  }
}

export interface ClaimedJob {
  id: bigint;
  kind: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

export class OutboxRepository {
  async enqueue(jobs: readonly OutboxJobInput[]): Promise<void> {
    if (jobs.length > 0) await prisma.outboxJob.createMany({ data: toRows(jobs) });
  }

  /** Claim up to `take` due jobs, hiding them until `leaseUntil`. */
  async claim(now: Date, leaseUntil: Date, take: number): Promise<ClaimedJob[]> {
    return prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "OutboxJob" SET "runAfter" = ${utc(leaseUntil)}, "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "OutboxJob" WHERE "runAfter" <= ${utc(now)}
        ORDER BY "runAfter", "id" LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "payload", "attempts"`;
  }

  /** Done: the row goes. */
  async finish(id: bigint): Promise<void> {
    await prisma.outboxJob.deleteMany({ where: { id } });
  }

  /** Failed: try again at `runAfter`, keeping the error for whoever looks. */
  async retryAt(id: bigint, runAfter: Date, error: string): Promise<void> {
    await prisma.outboxJob.updateMany({ where: { id }, data: { runAfter, lastError: error.slice(0, 2000) } });
  }

  /** Made progress but isn't finished (a big prefix): run again soon, without counting a failure. */
  async continueAt(id: bigint, runAfter: Date): Promise<void> {
    await prisma.outboxJob.updateMany({ where: { id }, data: { runAfter, attempts: 0, lastError: null } });
  }

  /** How many jobs are waiting, and the oldest one's age — for the drain's summary. */
  async backlog(): Promise<{ count: number; oldest: Date | null; failing: number }> {
    const [count, oldest, failing] = await Promise.all([
      prisma.outboxJob.count(),
      prisma.outboxJob.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      prisma.outboxJob.count({ where: { lastError: { not: null } } }),
    ]);
    return { count, oldest: oldest?.createdAt ?? null, failing };
  }
}

export const outboxRepository = new OutboxRepository();
