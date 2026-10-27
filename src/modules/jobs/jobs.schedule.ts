import { IST_OFFSET_MINUTES } from "../../common/time";

// Pure scheduling rules for the worker (deviation D5): when a job is due, and whether a run may be
// claimed. Daily jobs run once per IST date, monthly ones once per IST month; interval jobs every N
// minutes, keeping one JobRun row per IST date. No database, no clock of their own — check:tree,
// check:storage and check:metering pin them.

/** The IST calendar date and minute-of-day of an instant (jobs run on India time: +05:30, no DST). */
export const istParts = (now: Date): { date: string; minuteOfDay: number } => {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
};

const parseHhmm = (hhmm: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid daily time "${hhmm}" (expected HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * The period a daily job at `atIst` is due for right now — today's IST date once that time has
 * passed — or null before it. One run per period: missing a day (worker down) catches up the same
 * day; it never runs twice.
 */
export const duePeriod = (atIst: string, now: Date): string | null => {
  const { date, minuteOfDay } = istParts(now);
  return minuteOfDay >= parseHhmm(atIst) ? date : null;
};

/**
 * The period a monthly job (on the 1st at `atIst`) is due for right now — this IST month, "YYYY-MM",
 * from that moment on — or null before it. A run missed on the 1st (worker down) catches up later
 * in the month; it never runs twice in one month.
 */
export const dueMonthlyPeriod = (atIst: string, now: Date): string | null => {
  const at = parseHhmm(atIst);
  const { date, minuteOfDay } = istParts(now);
  return !date.endsWith("-01") || minuteOfDay >= at ? date.slice(0, 7) : null;
};

export interface RunState {
  status: string; // RUNNING | SUCCEEDED | FAILED
  startedAt: Date;
  finishedAt: Date | null;
}

/** A RUNNING row older than this is a crashed run, and may be claimed again. */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** A FAILED run is retried after this pause. */
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
/** An interval job's RUNNING row older than this (or two intervals, if longer) is a crashed run. */
export const STALE_INTERVAL_RUN_MS = 10 * 60 * 1000;
/** The scheduler ticks every minute, give or take; an interval job is due this much early, so it never skips a tick. */
export const TICK_SLACK_MS = 5_000;

/**
 * Whether a worker may start this job's run for the period, given the run recorded so far.
 * `intervalMs` set: an interval job, whose day's row is claimed again once the interval has
 * passed since the last start (a failure retries after the interval, or RETRY_AFTER_FAILURE_MS if
 * that's sooner).
 */
export const mayClaim = (run: RunState | null, now: Date, intervalMs: number | null = null): boolean => {
  if (!run) return true;
  const sinceStart = now.getTime() - run.startedAt.getTime();
  const sinceEnd = now.getTime() - (run.finishedAt ?? run.startedAt).getTime();
  if (intervalMs === null) {
    if (run.status === "SUCCEEDED") return false;
    if (run.status === "RUNNING") return sinceStart > STALE_RUN_MS;
    return sinceEnd > RETRY_AFTER_FAILURE_MS;
  }
  if (run.status === "RUNNING") return sinceStart > Math.max(STALE_INTERVAL_RUN_MS, 2 * intervalMs);
  if (run.status === "SUCCEEDED") return sinceStart >= intervalMs - TICK_SLACK_MS;
  return sinceEnd >= Math.min(RETRY_AFTER_FAILURE_MS, intervalMs) - TICK_SLACK_MS;
};
