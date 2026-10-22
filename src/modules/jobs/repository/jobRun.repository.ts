import { prisma } from "../../../prisma/client";
import { mayClaim } from "../jobs.schedule";

// JobRun bookkeeping for the worker. A run is CLAIMED under a transaction-scoped advisory lock (taken
// on the same connection as the claim, which a session-scoped lock behind a connection pool can't
// guarantee), so even two workers can never start the same job for the same period.

export class JobRunRepository {
  /**
   * Claim this job's run for the period. False if it already succeeded (daily) or ran too recently
   * (interval), is running, or is cooling off after a failure.
   */
  async claim(name: string, periodKey: string, now: Date, intervalMs: number | null = null): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`brimbox-job:${name}`})) AS locked`;
      if (!lock?.locked) return false;
      const key = { name_periodKey: { name, periodKey } };
      const run = await tx.jobRun.findUnique({ where: key });
      if (!mayClaim(run, now, intervalMs)) return false;
      await tx.jobRun.upsert({
        where: key,
        create: { name, periodKey, status: "RUNNING", attempts: 1, startedAt: now },
        update: { status: "RUNNING", attempts: { increment: 1 }, startedAt: now, finishedAt: null, error: null },
      });
      return true;
    });
  }

  async succeed(name: string, periodKey: string, now: Date, summary: string): Promise<void> {
    await prisma.jobRun.update({
      where: { name_periodKey: { name, periodKey } },
      data: { status: "SUCCEEDED", finishedAt: now, summary: summary.slice(0, 1000) },
    });
  }

  async fail(name: string, periodKey: string, now: Date, error: string): Promise<void> {
    await prisma.jobRun.update({
      where: { name_periodKey: { name, periodKey } },
      data: { status: "FAILED", finishedAt: now, error: error.slice(0, 2000) },
    });
  }
}

export const jobRunRepository = new JobRunRepository();
