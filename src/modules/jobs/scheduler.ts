import { duePeriod, istParts } from "./jobs.schedule";
import { jobRunRepository } from "./repository/jobRun.repository";

// The worker's scheduler (deviation D5): once a minute, every job that's due and unclaimed runs —
// a daily job once per IST date, an interval job every N minutes. Jobs must be idempotent: a crash
// mid-run means it runs again.

export interface JobSpec {
  name: string;
  /** IST time of day a daily job becomes due, "HH:MM". Set this or `everyMinutes`. */
  dailyAtIst?: string;
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

export const describeSchedule = (job: JobSpec): string =>
  job.dailyAtIst ? `daily @ ${job.dailyAtIst} IST` : `every ${job.everyMinutes} min`;

const intervalMsOf = (job: JobSpec): number | null => (job.everyMinutes ? job.everyMinutes * 60_000 : null);

export const startScheduler = (
  jobs: JobSpec[],
  options: { now?: () => Date; intervalMs?: number; autoStart?: boolean } = {}
): Scheduler => {
  for (const job of jobs) {
    const every = job.everyMinutes;
    const valid = job.dailyAtIst ? every === undefined : every !== undefined && Number.isInteger(every) && every >= 1;
    if (!valid) throw new Error(`Job ${job.name} needs exactly one of dailyAtIst or everyMinutes (a whole number ≥ 1)`);
  }
  const now = options.now ?? (() => new Date());
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return; // a long job is still running: the next tick picks up the rest
    busy = true;
    try {
      for (const job of jobs) {
        const period = job.dailyAtIst ? duePeriod(job.dailyAtIst, now()) : istParts(now()).date;
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
