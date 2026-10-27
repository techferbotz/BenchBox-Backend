import { BadRequestError, NotFoundError } from "../../../common/errors/AppError";
import { microToPaise, percentOf, percentString, roundedRatio } from "../../../common/money";
import { addDays, DAY_MS, daysBetween, isDate, istDate, istDayStart, monthEnd, monthOf, monthStart } from "../../../common/time";
import { isUuid } from "../../../common/validation";
import { USAGE_MAX_DAYS } from "../../metering/metering.policy";
import { PriceBookRow, projectMonth, requirePriceBook } from "../../metering/metering.rules";
import { DayUsage, meteringService } from "../../metering/service/metering.service";
import { PageDto } from "../../nodes/dto/node.dto";
import { decodeCursor, encodeCursor, invalidCursor, parseLimit } from "../../nodes/nodes.rules";
import { STATEMENTS_DEFAULT_LIMIT, STATEMENTS_MAX_LIMIT } from "../billing.policy";
import { BillTotals, billTotals, limitStateOf } from "../billing.rules";
import {
  BillingSummaryDto,
  StatementDto,
  toBillTotalsDto,
  toStatementDto,
  UsageDayDto,
  UsageDto,
} from "../dto/billing.dto";
import { billingRepository } from "../repository/billing.repository";
import { statementRepository } from "../repository/statement.repository";

// What the app shows about money (docs/BACKEND_PLAN.md §6–7): this month so far and projected, the
// daily usage behind it, and the statements. Everything is computed here, from the metering log;
// the app only displays it.

export interface BillingServiceDeps {
  now: () => Date;
}

/** This month's bill so far and projected, as the summary and the usage alerts see it. */
export interface MonthBill {
  month: string;
  book: PriceBookRow;
  /** Bytes stored now. */
  level: bigint;
  toDate: BillTotals;
  projected: BillTotals;
}

const MONTH_CURSOR = /^\d{4}-(0[1-9]|1[0-2])$/;

const decodeStatementCursor = (raw: unknown): string | null => {
  const value = decodeCursor(raw);
  if (!value) return null;
  if (typeof value.m !== "string" || !MONTH_CURSOR.test(value.m)) throw invalidCursor();
  return value.m;
};

const optionalDate = (raw: unknown, field: string): string | null => {
  if (raw === undefined) return null;
  if (!isDate(raw)) throw new BadRequestError(`"${field}" must be a date like 2026-10-01`);
  return raw;
};

export class BillingService {
  constructor(private readonly deps: BillingServiceDeps) {}

  /**
   * This month's bill so far and projected to its end: the month's days — closed, and metered live
   * up to `now` — priced by the month's price book, GST on top, plus any total carried from an
   * earlier statement below the minimum charge (it goes into this month's).
   */
  async month(userId: string, now: Date): Promise<MonthBill> {
    const month = monthOf(istDate(now));
    const [{ days, level, books }, carry] = await Promise.all([
      meteringService.daysSince(userId, monthStart(month), now),
      statementRepository.pendingCarry(userId),
    ]);
    const book = requirePriceBook(books, month);
    const { toDateMicroPaise, projectedMicroPaise } = projectMonth({ month, book, days, level, now });
    const carriedIn = carry?.totalPaise ?? 0n;
    return {
      month,
      book,
      level,
      toDate: billTotals(toDateMicroPaise, book.gstBasisPoints, carriedIn),
      projected: billTotals(projectedMicroPaise, book.gstBasisPoints, carriedIn),
    };
  }

  /** GET /api/v1/billing/summary */
  async summary(userId: string): Promise<BillingSummaryDto> {
    const now = this.deps.now();
    const [bill, limit, last] = await Promise.all([
      this.month(userId, now),
      billingRepository.limitOf(userId),
      statementRepository.latest(userId),
    ]);
    const { book } = bill;
    const toDate = bill.toDate.totalPaise;
    const projected = bill.projected.totalPaise;
    return {
      asOf: now.toISOString(),
      month: bill.month,
      periodStart: monthStart(bill.month),
      periodEnd: monthEnd(bill.month),
      statementDate: addDays(monthEnd(bill.month), 1),
      storedBytes: Number(bill.level),
      price: {
        paisePerGbMonth: book.storagePaisePerGbMonth.toString(),
        freeBytes: Number(book.freeBytes),
        gstPercent: percentString(book.gstBasisPoints),
        minimumChargePaise: book.minimumChargePaise.toString(),
      },
      monthToDate: toBillTotalsDto(bill.toDate),
      projected: toBillTotalsDto(bill.projected),
      limitPaise: limit === null ? null : limit.toString(),
      limitState: limit === null ? null : limitStateOf(toDate, projected, limit),
      limitUsedPercent: limit === null ? null : percentOf(toDate, limit),
      lastStatement: last ? toStatementDto(last) : null,
    };
  }

  /**
   * GET /api/v1/billing/usage?from&to — one entry per IST day from `from` (default: the 1st of
   * `to`'s month) to `to` (default and latest: today), zeros where nothing was stored. Today's
   * entry is the day so far.
   */
  async usage(userId: string, fromRaw: unknown, toRaw: unknown): Promise<UsageDto> {
    const now = this.deps.now();
    const today = istDate(now);
    const requestedTo = optionalDate(toRaw, "to");
    const to = requestedTo === null || requestedTo > today ? today : requestedTo;
    const from = optionalDate(fromRaw, "from") ?? monthStart(monthOf(to));
    if (from > to) return { from, to, days: [] };
    if (daysBetween(from, to) + 1 > USAGE_MAX_DAYS) {
      throw new BadRequestError(`At most ${USAGE_MAX_DAYS} days at a time`);
    }

    const { days } = await meteringService.daysSince(userId, from, now);
    const byDay = new Map(days.map((day): [string, DayUsage] => [day.day, day]));
    const entries: UsageDayDto[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const day = byDay.get(date);
      if (!day) {
        entries.push({ date, averageBytes: 0, peakBytes: 0, endBytes: 0, chargePaise: "0", complete: date < today });
        continue;
      }
      const span = day.complete ? DAY_MS : now.getTime() - istDayStart(date).getTime();
      entries.push({
        date,
        averageBytes: span > 0 ? Number(roundedRatio(day.byteMs, BigInt(span))) : Number(day.endBytes),
        peakBytes: Number(day.peakBytes),
        endBytes: Number(day.endBytes),
        chargePaise: microToPaise(day.chargeMicroPaise).toString(),
        complete: day.complete,
      });
    }
    return { from, to, days: entries };
  }

  /** GET /api/v1/billing/statements — newest first. */
  async listStatements(userId: string, cursorRaw: unknown, limitRaw: unknown): Promise<PageDto<StatementDto>> {
    const limit = parseLimit(limitRaw, STATEMENTS_DEFAULT_LIMIT, STATEMENTS_MAX_LIMIT);
    const rows = await statementRepository.list(userId, decodeStatementCursor(cursorRaw), limit + 1);
    const page = rows.slice(0, limit).map(toStatementDto);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: rows.length > limit && last ? encodeCursor({ m: last.month }) : null,
      hasMore: rows.length > limit,
    };
  }

  /** GET /api/v1/billing/statements/:id — someone else's, or a malformed id: 404. */
  async getStatement(userId: string, id: string): Promise<StatementDto> {
    const statement = isUuid(id) ? await statementRepository.findOwned(userId, id.toLowerCase()) : null;
    if (!statement) throw new NotFoundError("Statement not found");
    return toStatementDto(statement);
  }
}

export const billingService = new BillingService({ now: () => new Date() });
