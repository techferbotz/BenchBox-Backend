import { dueMonthlyPeriod, duePeriod, istParts } from "./jobs.schedule";
import { jobRunRepository } from "./repository/jobRun.repository";

// The worker's scheduler (deviation D5): once a minute, every job that's due and unclaimed runs —
// a daily job once per IST date, a monthly job once per IST month, an interval job every N minutes.
// Jobs must be idempotent: a crash mid-run means it runs again.

export interface JobSpec {
  name: string;
  /** IST time of day a daily job becomes due, "HH:MM". Set exactly one of the three schedules. */
  dailyAtIst?: string;
  /** IST time on the 1st of each month a monthly job becomes due, "HH:MM". */
  monthlyAtIst?: string;
  /** Run every this many minutes. */
  everyMinutes?: number;
  /** Does the work; returns a one-line summary for the JobRun row and the log. */
  run: (now: Date) => Promise<string>;
  /** For a frequent job: whether a summary means it found nothing to do (then it isn't logged). */
  idle?: (summary: string) => boolean;
}

export interface Scheduler {
  /** One pass over every job (also what the timer calls). */
  tick: () => Promise<void>;
  stop: () => void;
}

export const describeSchedule = (job: JobSpec): string => {
  if (job.dailyAtIst) return `daily @ ${job.dailyAtIst} IST`;
  if (job.monthlyAtIst) return `monthly on the 1st @ ${job.monthlyAtIst} IST`;
  return `every ${job.everyMinutes} min`;
};

const intervalMsOf = (job: JobSpec): number | null => (job.everyMinutes ? job.everyMinutes * 60_000 : null);

/** The period the job is due for now (null: not yet), which is also its JobRun key. */
const periodOf = (job: JobSpec, now: Date): string | null => {
  if (job.dailyAtIst) return duePeriod(job.dailyAtIst, now);
  if (job.monthlyAtIst) return dueMonthlyPeriod(job.monthlyAtIst, now);
  return istParts(now).date;
};

export const startScheduler = (
  jobs: JobSpec[],
  options: { now?: () => Date; intervalMs?: number; autoStart?: boolean } = {}
): Scheduler => {
  for (const job of jobs) {
    const every = job.everyMinutes;
    const schedules = [job.dailyAtIst, job.monthlyAtIst, every].filter((value) => value !== undefined).length;
    const valid = schedules === 1 && (every === undefined || (Number.isInteger(every) && every >= 1));
    if (!valid) throw new Error(`Job ${job.name} needs exactly one of dailyAtIst, monthlyAtIst or everyMinutes (a whole number ≥ 1)`);
    periodOf(job, new Date()); // a malformed HH:MM fails the boot, not the job's first run
  }
  const now = options.now ?? (() => new Date());
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return; // a long job is still running: the next tick picks up the rest
    busy = true;
    try {
      for (const job of jobs) {
        const period = periodOf(job, now());
        if (period === null) continue;
        if (!(await jobRunRepository.claim(job.name, period, now(), intervalMsOf(job)))) continue;
        const started = Date.now();
        try {
          const summary = await job.run(now());
          await jobRunRepository.succeed(job.name, period, now(), summary);
          if (!job.idle?.(summary)) {
            console.log(`[worker] ${job.name} ${period} ok in ${Date.now() - started}ms: ${summary}`);
          }
        } catch (err) {
          const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
          await jobRunRepository.fail(job.name, period, now(), message);
          console.error(`[worker] ${job.name} ${period} FAILED after ${Date.now() - started}ms:`, err);
        }
      }
    } catch (err) {
      // e.g. the database is unreachable: log and try again on the next tick
      console.error("[worker] scheduler tick failed:", err);
    } finally {
      busy = false;
    }
  };

  if (options.autoStart === false) return { tick, stop: () => undefined };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
};
