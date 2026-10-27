import { NotFoundError } from "../../../common/errors/AppError";
import { addDays, istDate, istDayEnd, monthOf } from "../../../common/time";
import { EVENT_PAGE_SIZE } from "../metering.policy";
import {
  billableByteMs,
  dayChargeMicroPaise,
  MeteredDay,
  meterDays,
  MeterEvent,
  MeterState,
  PriceBookRow,
  requirePriceBook,
} from "../metering.rules";
import { meteringRepository, MeterTx, UsageDayRow } from "../repository/metering.repository";

// Metering (docs/BACKEND_PLAN.md §6): live storage numbers, the price book, and the daily close that
// turns the StorageEvent log into priced UsageDays — the input to every bill.

export interface StorageUsageDto {
  // Billed bytes: every file, trash included, until purged.
  usedBytes: number;
  // The part of usedBytes that is in the trash.
  trashBytes: number;
  // What unfinished uploads have reserved against the limit.
  uploadingBytes: number;
  // The free allowance.
  freeBytes: number;
  // The most the account may store right now; null = no limit (from P5, with auto-pay set up).
  limitBytes: number | null;
}

/** One day's usage, closed or metered live, with its exact charge. */
export interface DayUsage {
  day: string;
  byteMs: bigint;
  billableByteMs: bigint;
  peakBytes: bigint;
  endBytes: bigint;
  chargeMicroPaise: bigint;
  /** The day is over. Only today is still in progress. */
  complete: boolean;
}

const DAILY_CLOSE_BATCH = 200;

const startState = (last: UsageDayRow | null): MeterState =>
  last ? { day: last.day, level: last.endBytes, lastEventId: last.lastEventId } : { day: null, level: 0n, lastEventId: 0n };

/** A metered day, priced by its month's book. */
const priced = (day: MeteredDay, books: readonly PriceBookRow[]): DayUsage & { priceBookId: string; lastEventId: bigint } => {
  const book = requirePriceBook(books, monthOf(day.day));
  return {
    day: day.day,
    byteMs: day.byteMs,
    billableByteMs: billableByteMs(day.byteMs, book),
    peakBytes: day.peakBytes,
    endBytes: day.endBytes,
    chargeMicroPaise: dayChargeMicroPaise(day.day, day.byteMs, book),
    complete: day.complete,
    priceBookId: book.id,
    lastEventId: day.lastEventId,
  };
};

/**
 * Read an account's events after `afterId`, page by page, until one takes effect at or after
 * `stopAt` (it and everything after it can wait) or the log runs out.
 */
const readEvents = async (
  read: (afterId: bigint, take: number) => Promise<MeterEvent[]>,
  afterId: bigint,
  stopAt: Date | null
): Promise<MeterEvent[]> => {
  const events: MeterEvent[] = [];
  for (let after = afterId; ; ) {
    const page = await read(after, EVENT_PAGE_SIZE);
    events.push(...page);
    if (page.length < EVENT_PAGE_SIZE || (stopAt && page.some((event) => event.at >= stopAt))) return events;
    after = page[page.length - 1]!.id;
  }
};

export class MeteringService {
  /** The price book for the IST month `now` falls in. */
  async priceBookAt(now: Date): Promise<PriceBookRow> {
    return requirePriceBook(await meteringRepository.priceBooks(), monthOf(istDate(now)));
  }

  /**
   * How many bytes the account may store, or null for no limit: the free allowance of this month's
   * price book. From P5, an active auto-pay mandate or Play credit lifts it.
   */
  async storageAllowance(userId: string, now: Date): Promise<bigint | null> {
    return this.allowanceFor(userId, await this.priceBookAt(now));
  }

  private allowanceFor(_userId: string, book: PriceBookRow): bigint | null {
    return book.freeBytes;
  }

  async usage(userId: string, now: Date): Promise<StorageUsageDto> {
    const [row, book] = await Promise.all([meteringRepository.usage(userId), this.priceBookAt(now)]);
    if (!row) throw new NotFoundError("Account not found");
    const allowance = this.allowanceFor(userId, book);
    return {
      usedBytes: Number(row.storedBytes),
      trashBytes: Number(row.trashBytes),
      uploadingBytes: Number(row.reservedBytes),
      freeBytes: Number(book.freeBytes),
      limitBytes: allowance === null ? null : Number(allowance),
    };
  }

  /**
   * Job (metering.closeDay, daily after midnight IST): close every account's days through
   * yesterday. Idempotent: a day once closed is never written again.
   */
  async closeDays(now: Date): Promise<string> {
    const through = addDays(istDate(now), -1);
    const books = await meteringRepository.priceBooks();
    let accounts = 0;
    let days = 0;
    for (let after: string | null = null; ; ) {
      const ids = await meteringRepository.accountsToClose(through, after, DAILY_CLOSE_BATCH);
      for (const id of ids) {
        days += await meteringRepository.inAccountLock(id, (meter) => this.closeAccount(meter, through, books));
        accounts += 1;
      }
      if (ids.length < DAILY_CLOSE_BATCH) break;
      after = ids[ids.length - 1]!;
    }
    return `closed ${days} day(s) for ${accounts} account(s) through ${through}`;
  }

  /**
   * Close one account's days through `through`, inside a transaction holding its row lock (the
   * statement close shares it). It resumes after the account's newest closed day and never touches
   * a closed one, so running it again writes nothing. Returns the number of days written.
   */
  async closeAccount(meter: MeterTx, through: string, books: readonly PriceBookRow[]): Promise<number> {
    const last = await meter.lastDay();
    if (last && last.day >= through) return 0;
    const state = startState(last);
    const events = await readEvents((after, take) => meter.eventsAfter(after, take), state.lastEventId, istDayEnd(through));
    const rows: UsageDayRow[] = meterDays(state, events, through).days.map((day) => priced(day, books));
    await meter.addDays(rows);
    return rows.length;
  }

  /**
   * The account's days from `from` through today: closed days as the close wrote them, the rest
   * metered live up to `now` (today's so far). Days with nothing stored are absent. Also the bytes
   * stored now, from the same reading of the log.
   */
  async daysSince(userId: string, from: string, now: Date): Promise<{ days: DayUsage[]; level: bigint; books: PriceBookRow[] }> {
    const [{ days: closed, last }, books] = await Promise.all([
      meteringRepository.closedDaysSince(userId, from),
      meteringRepository.priceBooks(),
    ]);
    const state = startState(last);
    const events = await readEvents((after, take) => meteringRepository.eventsAfter(userId, after, take), state.lastEventId, null);
    const live = meterDays(state, events, istDate(now), now);
    return {
      days: [
        ...closed.map((row): DayUsage => ({ ...row, complete: true })),
        ...live.days.filter((day) => day.day >= from).map((day) => priced(day, books)),
      ],
      level: live.level,
      books,
    };
  }
}

export const meteringService = new MeteringService();
