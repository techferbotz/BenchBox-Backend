import { gstOn, microToPaise, reachesPercent } from "../../common/money";
import { NotificationContent } from "../notifications/notifications.messages";
import { LIMIT_ALERT_PERCENTS } from "./billing.policy";

// Pure billing rules (docs/BACKEND_PLAN.md §7.2, §7.4): how exact charges become a bill, and which
// usage alerts an account is due. No database, no clock: check:metering pins them.

export interface BillTotals {
  /** The storage charge: the exact charges, rounded half-up once. */
  subtotalPaise: bigint;
  gstPaise: bigint;
  carriedInPaise: bigint;
  totalPaise: bigint;
}

/** A bill from exact charges: subtotal rounded once, GST on the subtotal, plus a carried amount. */
export const billTotals = (chargeMicroPaise: bigint, gstBasisPoints: number, carriedInPaise: bigint): BillTotals => {
  const subtotalPaise = microToPaise(chargeMicroPaise);
  const gstPaise = gstOn(subtotalPaise, gstBasisPoints);
  return { subtotalPaise, gstPaise, carriedInPaise, totalPaise: subtotalPaise + gstPaise + carriedInPaise };
};

/** Below the minimum charge, a statement isn't collected: its total goes into the next statement. */
export const statementStatusFor = (totalPaise: bigint, minimumChargePaise: bigint): "OPEN" | "CARRIED" =>
  totalPaise >= minimumChargePaise ? "OPEN" : "CARRIED";

/**
 * Where this month stands against the monthly limit: passed it (so far ≥ limit), heading past it
 * (the projection is above it), or on track.
 */
export type LimitState = "on_track" | "projected_over" | "over";
export const limitStateOf = (toDatePaise: bigint, projectedPaise: bigint, limitPaise: bigint): LimitState =>
  toDatePaise >= limitPaise ? "over" : projectedPaise > limitPaise ? "projected_over" : "on_track";

export interface DueAlert {
  dedupeKey: string;
  content: NotificationContent;
  /** Recorded but not sent: a bigger alert went out instead. */
  supersededBy?: string;
}

/**
 * The usage alerts an account is due this month (§7.4), given its totals so far and projected
 * (GST and any carried amount included: what auto-pay would be asked for). Each is keyed by the
 * month AND the limit, so it fires once per month — and a changed limit re-arms them.
 *   - LIMIT_ALERT at each of LIMIT_ALERT_PERCENTS reached. Only the highest reached goes out; lower
 *     ones reached at the same time are recorded as superseded, so they never go out late.
 *   - PROJECTED_OVER_LIMIT (push only) when the projection is above the limit — superseded once
 *     the limit itself has been passed.
 * Making an alert whose key exists is a no-op, so this can run every hour.
 */
export const dueAlerts = (input: {
  userId: string;
  month: string;
  limitPaise: bigint;
  toDatePaise: bigint;
  projectedPaise: bigint;
}): DueAlert[] => {
  const { userId, month, limitPaise, toDatePaise, projectedPaise } = input;
  if (limitPaise <= 0n) return [];
  const limit = limitPaise.toString();
  const reached = LIMIT_ALERT_PERCENTS.filter((percent) => reachesPercent(toDatePaise, limitPaise, percent));
  const top = reached[reached.length - 1];
  const alerts: DueAlert[] = reached.map((percent) => ({
    dedupeKey: `limit${percent}:${userId}:${month}:${limit}`,
    content: { type: "LIMIT_ALERT", payload: { month, percent, limitPaise: limit, toDatePaise: toDatePaise.toString() } },
    ...(percent !== top ? { supersededBy: `the ${top}% alert` } : {}),
  }));
  if (projectedPaise > limitPaise) {
    alerts.push({
      dedupeKey: `projected:${userId}:${month}:${limit}`,
      content: { type: "PROJECTED_OVER_LIMIT", payload: { month, limitPaise: limit, projectedPaise: projectedPaise.toString() } },
      ...(toDatePaise >= limitPaise ? { supersededBy: "the limit being passed" } : {}),
    });
  }
  return alerts;
};
