import { Statement } from "@prisma/client";
import { BYTES_PER_GB, percentString, ratioString } from "../../../common/money";
import { DAY_MS, daysInMonth, fromDateColumn, monthOf } from "../../../common/time";
import { secondsToByteMs } from "../../metering/metering.rules";
import { BillTotals, LimitState } from "../billing.rules";

// Response shapes for /api/v1/billing (docs/FRONTEND_API.md §10). Money is a decimal string of
// paise; sizes are JSON numbers of bytes; dates and months are India time. The app shows these
// amounts as they come: it never computes a charge.

export interface BillTotalsDto {
  /** The storage charge (the month's exact charges, rounded once). */
  subtotalPaise: string;
  gstPaise: string;
  /** An earlier bill below the minimum charge, carried into this one. */
  carriedInPaise: string;
  totalPaise: string;
}

export const toBillTotalsDto = (totals: BillTotals): BillTotalsDto => ({
  subtotalPaise: totals.subtotalPaise.toString(),
  gstPaise: totals.gstPaise.toString(),
  carriedInPaise: totals.carriedInPaise.toString(),
  totalPaise: totals.totalPaise.toString(),
});

export interface PriceDto {
  paisePerGbMonth: string;
  /** Free storage, all day, every day. */
  freeBytes: number;
  /** e.g. "18". */
  gstPercent: string;
  /** A bill below this is carried into the next one. */
  minimumChargePaise: string;
}

export interface StatementDto {
  id: string;
  /** "2026-10" */
  month: string;
  periodStart: string;
  periodEnd: string;
  /** open: to be collected · carried: below the minimum charge, so its total goes into the next statement. */
  status: "open" | "carried";
  /** The month's usage in GB-days and GB-months, as decimal strings with two decimals. */
  usage: { gbDays: string; freeGbDays: string; billableGbDays: string; billableGbMonths: string };
  paisePerGbMonth: string;
  gstPercent: string;
  subtotalPaise: string;
  gstPaise: string;
  carriedInPaise: string;
  totalPaise: string;
  /** A carried statement: the statement its total went into, once there is one. */
  carriedIntoId: string | null;
  createdAt: string;
}

const GB_DAY_BYTE_MS = BYTES_PER_GB * BigInt(DAY_MS);

export const toStatementDto = (statement: Statement): StatementDto => {
  const month = monthOf(fromDateColumn(statement.periodStart));
  const byteMs = secondsToByteMs(statement.byteSeconds.toFixed(3));
  const billableByteMs = secondsToByteMs(statement.billableByteSeconds.toFixed(3));
  return {
    id: statement.id,
    month,
    periodStart: fromDateColumn(statement.periodStart),
    periodEnd: fromDateColumn(statement.periodEnd),
    status: statement.status === "OPEN" ? "open" : "carried",
    usage: {
      gbDays: ratioString(byteMs, GB_DAY_BYTE_MS, 2),
      freeGbDays: ratioString(byteMs - billableByteMs, GB_DAY_BYTE_MS, 2),
      billableGbDays: ratioString(billableByteMs, GB_DAY_BYTE_MS, 2),
      billableGbMonths: ratioString(billableByteMs, GB_DAY_BYTE_MS * BigInt(daysInMonth(month)), 2),
    },
    paisePerGbMonth: statement.storagePaisePerGbMonth.toString(),
    gstPercent: percentString(statement.gstBasisPoints),
    subtotalPaise: statement.subtotalPaise.toString(),
    gstPaise: statement.gstPaise.toString(),
    carriedInPaise: statement.carriedInPaise.toString(),
    totalPaise: statement.totalPaise.toString(),
    carriedIntoId: statement.carriedIntoId,
    createdAt: statement.createdAt.toISOString(),
  };
};

export interface BillingSummaryDto {
  /** When these numbers were worked out. */
  asOf: string;
  /** The billing month in progress, India time. */
  month: string;
  periodStart: string;
  periodEnd: string;
  /** When this month's statement closes. */
  statementDate: string;
  /** Stored now, the trash included: what is being billed. */
  storedBytes: number;
  price: PriceDto;
  /** This month so far: what the bill would be if the month ended now. */
  monthToDate: BillTotalsDto;
  /** The month's bill if what is stored now stays until the month ends. */
  projected: BillTotalsDto;
  /** The monthly auto-pay limit; null without one (until P5's auto-pay, always null). */
  limitPaise: string | null;
  /** on_track · projected_over (the projection is above the limit) · over (this month so far has reached it). Null without a limit. */
  limitState: LimitState | null;
  /** This month so far, as a whole percentage of the limit (rounded down). Null without a limit. */
  limitUsedPercent: number | null;
  lastStatement: StatementDto | null;
}

export interface UsageDayDto {
  date: string;
  /** Average bytes stored over the day — over the part that has passed, for today. */
  averageBytes: number;
  peakBytes: number;
  /** Stored at the day's end (now, for today). */
  endBytes: number;
  /** The day's charge, rounded to the paisa for display. Statements round the month's exact total once, so days can differ from the bill by a paisa or two. */
  chargePaise: string;
  /** false only for today. */
  complete: boolean;
}

export interface UsageDto {
  from: string;
  to: string;
  days: UsageDayDto[];
}
