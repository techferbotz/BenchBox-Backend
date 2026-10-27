import { storageChargeMicroPaise } from "../../common/money";
import {
  addDays,
  addMonths,
  DAY_MS,
  daysBetween,
  daysInMonth,
  istDate,
  istDayEnd,
  istDayStart,
  monthEnd,
  monthOf,
  monthStart,
} from "../../common/time";
import { PRICE_CHANGE_NOTICE_DAYS } from "./metering.policy";

// Pure metering rules (docs/BACKEND_PLAN.md §6): stored bytes are a step function of time, changed
// only by StorageEvents; a day's usage is its integral, priced per day of the actual month. No
// database, no clock of their own: check:metering pins them, the worked example included.

// ---------------------------------------------------------------- prices

/** A PriceBook row, as the rules see it. */
export interface PriceBookRow {
  id: string;
  /** The IST date it takes effect, always the 1st of a month. */
  effectiveFrom: string;
  storagePaisePerGbMonth: bigint;
  freeBytes: bigint;
  gstBasisPoints: number;
  minimumChargePaise: bigint;
  createdAt: Date;
}

/** Charges more than `before` did: a higher price per GB-month, or a smaller free allowance. */
const raisesPrice = (before: PriceBookRow, after: PriceBookRow): boolean =>
  after.storagePaisePerGbMonth > before.storagePaisePerGbMonth || after.freeBytes < before.freeBytes;

/** The first month an increase recorded at `recordedAt` may apply in: one that starts at least PRICE_CHANGE_NOTICE_DAYS later. */
export const firstMonthAfterNotice = (recordedAt: Date): string => {
  const earliest = new Date(recordedAt.getTime() + PRICE_CHANGE_NOTICE_DAYS * DAY_MS);
  const month = monthOf(istDate(earliest));
  return istDayStart(monthStart(month)).getTime() >= earliest.getTime() ? month : addMonths(month, 1);
};

/**
 * The price book that prices `month` ("YYYY-MM"): the newest one in effect by the month's start.
 * A book that raises the price over the one before it waits until firstMonthAfterNotice(its
 * createdAt), whatever its effectiveFrom says, so the Terms' notice promise holds even if a row is
 * added late. Null when no book covers the month.
 */
export const priceBookFor = (books: readonly PriceBookRow[], month: string): PriceBookRow | null => {
  const start = monthStart(month);
  let current: PriceBookRow | null = null;
  for (const book of [...books].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
    if (book.effectiveFrom > start) break;
    if (current && raisesPrice(current, book) && month < firstMonthAfterNotice(book.createdAt)) continue;
    current = book;
  }
  return current;
};

export const requirePriceBook = (books: readonly PriceBookRow[], month: string): PriceBookRow => {
  const book = priceBookFor(books, month);
  if (!book) throw new Error(`No price book covers ${month}: add a PriceBook row effective on or before ${monthStart(month)}`);
  return book;
};

// ---------------------------------------------------------------- integrating the log

/** A StorageEvent, as metering sees it. */
export interface MeterEvent {
  id: bigint;
  at: Date;
  /** Stored bytes after the change. */
  totalAfter: bigint;
}

/** Where metering stands after a day: the bytes stored at its end and the last event it took in. */
export interface MeterState {
  /** The last IST day metered; null before the account's first. */
  day: string | null;
  level: bigint;
  lastEventId: bigint;
}

export interface MeteredDay {
  day: string;
  /** ∫ stored bytes dt from the day's start to its end — or to `until`, for the day in progress. */
  byteMs: bigint;
  peakBytes: bigint;
  endBytes: bigint;
  lastEventId: bigint;
  /** Whether the whole day was metered (false for the day in progress). */
  complete: boolean;
}

/**
 * Integrate stored bytes over IST days: from the day after `state.day` (or the day of the first
 * event) through `through`, ending at `until` if that falls inside `through` (the day in progress).
 *
 * `events` are the account's StorageEvents after `state.lastEventId`, in id order: commit order,
 * because they are written under the account's row lock. An event's `at` is its writer's clock,
 * read just before taking that lock, so it can trail the event before it. Each event therefore
 * takes effect at max(its `at`, the previous event's effect) — the log never runs backwards — and
 * never before the first day walked: an event that committed after its day closed counts from the
 * next day's start. Events taking effect after the walk are left for the next one.
 *
 * Days with nothing stored and no events are skipped: there is nothing to bill. Returns the days
 * and the bytes stored where the walk ended.
 */
export const meterDays = (
  state: MeterState,
  events: readonly MeterEvent[],
  through: string,
  until?: Date
): { days: MeteredDay[]; level: bigint } => {
  const days: MeteredDay[] = [];
  let level = state.level;
  let lastEventId = state.lastEventId;
  let next = 0;
  const first = state.day !== null ? addDays(state.day, 1) : events[0] ? istDate(events[0].at) : null;
  if (first === null) return { days, level };
  let floor = istDayStart(first).getTime();
  const effectOf = (event: MeterEvent): number => Math.max(event.at.getTime(), floor);

  for (let day = first; day <= through; ) {
    const start = istDayStart(day).getTime();
    const dayEnd = start + DAY_MS;
    const end = until ? Math.min(dayEnd, Math.max(start, until.getTime())) : dayEnd;
    let t = start;
    let byteMs = 0n;
    let peak = 0n;
    let touched = false;
    for (; next < events.length; next += 1) {
      const event = events[next]!;
      const effect = effectOf(event);
      if (effect >= end) break;
      byteMs += level * BigInt(effect - t);
      if (effect > t && level > peak) peak = level;
      t = effect;
      floor = effect;
      level = event.totalAfter;
      lastEventId = event.id;
      touched = true;
    }
    byteMs += level * BigInt(end - t);
    if (end > t && level > peak) peak = level;
    if (touched || level > 0n) {
      days.push({ day, byteMs, peakBytes: peak, endBytes: level, lastEventId, complete: end === dayEnd });
    }
    if (end < dayEnd) break; // `until` fell inside this day

    day = addDays(day, 1);
    if (level === 0n) {
      // Nothing stored: jump to the day of the next event, if there is one.
      const upcoming = events[next];
      if (!upcoming) break;
      const eventDay = istDate(new Date(effectOf(upcoming)));
      if (eventDay > day) day = eventDay;
    }
  }
  return { days, level };
};

// ---------------------------------------------------------------- pricing

/**
 * A day's usage above its free allowance (freeBytes all day long), in byte-milliseconds. The day
 * in progress gets the whole day's allowance, so its charge so far only ever grows, and equals the
 * close's once the day is over.
 */
export const billableByteMs = (byteMs: bigint, book: PriceBookRow): bigint => {
  const free = book.freeBytes * BigInt(DAY_MS);
  return byteMs > free ? byteMs - free : 0n;
};

/** The exact charge for `byteMs` of usage on `day`, in micro-paise, priced by `book`. */
export const dayChargeMicroPaise = (day: string, byteMs: bigint, book: PriceBookRow): bigint =>
  storageChargeMicroPaise(billableByteMs(byteMs, book), book.storagePaisePerGbMonth, daysInMonth(monthOf(day)));

export interface MonthProjection {
  /** The month so far, today's charge so far included. */
  toDateMicroPaise: bigint;
  /** To date, plus the rest of the month at the level stored now. */
  projectedMicroPaise: bigint;
}

/**
 * The month's charges so far and projected to its end (docs/BACKEND_PLAN.md §6, "Live numbers"):
 * `days` are the month's days so far — closed ones, and the rest metered live through now — and
 * `level` the bytes stored now. Days of other months are ignored.
 */
export const projectMonth = (input: {
  month: string;
  book: PriceBookRow;
  days: readonly { day: string; byteMs: bigint; chargeMicroPaise: bigint }[];
  level: bigint;
  now: Date;
}): MonthProjection => {
  const { month, book, level, now } = input;
  const today = istDate(now);
  let toDate = 0n;
  let todaySoFar = 0n;
  let todayCharged = 0n;
  for (const day of input.days) {
    if (monthOf(day.day) !== month) continue;
    toDate += day.chargeMicroPaise;
    if (day.day === today) {
      todaySoFar = day.byteMs;
      todayCharged = day.chargeMicroPaise;
    }
  }
  if (monthOf(today) !== month) return { toDateMicroPaise: toDate, projectedMicroPaise: toDate };

  // Today at the current level until midnight, then every day left in the month.
  const restOfToday = BigInt(istDayEnd(today).getTime() - now.getTime());
  const todayProjected = dayChargeMicroPaise(today, todaySoFar + level * restOfToday, book);
  const daysLeft = BigInt(daysBetween(today, monthEnd(month)));
  const fullDay = dayChargeMicroPaise(today, level * BigInt(DAY_MS), book);
  return { toDateMicroPaise: toDate, projectedMicroPaise: toDate - todayCharged + todayProjected + daysLeft * fullDay };
};

// ---------------------------------------------------------------- representation

/** byte-milliseconds → byte-seconds with three decimals, as the Decimal(38, 3) columns hold them. */
export const byteMsToSeconds = (byteMs: bigint): string =>
  `${byteMs / 1000n}.${(byteMs % 1000n).toString().padStart(3, "0")}`;

/** The reverse: a byte-seconds decimal string (any number of decimals up to three) → byte-milliseconds. */
export const secondsToByteMs = (seconds: string): bigint => {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(seconds);
  if (!match) throw new Error(`Not a byte-seconds value: ${seconds}`);
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
};
