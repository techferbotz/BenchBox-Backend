// Billing policy numbers (docs/BACKEND_PLAN.md §7). The billing windows are public promises — the
// Terms quote them — so they live here, with the module that enforces them, and the legal page
// imports them. Prices are data (the PriceBook table), not constants.
// TODO(decision): the windows are suggested defaults, not yet confirmed (docs/BACKEND_PLAN.md §13).

/**
 * Usage alerts, as percentages of the monthly limit: each is sent once per month (and limit) when
 * this month so far reaches it. Enforced by billing.alerts.
 */
export const LIMIT_ALERT_PERCENTS = [80, 100] as const;

/** Days a payment link for an amount above the limit (or a failed debit) stays due. Enforced from P5 (settlement). */
export const PAYMENT_DUE_DAYS = 7;
/** Days an account stays read-only (past due) before it is suspended. Enforced from P5 (billing.standing). */
export const PAST_DUE_TO_SUSPENDED_DAYS = 15;
/** Days an account stays suspended before its data is permanently deleted. Enforced from P5 (billing.standing). */
export const SUSPENDED_TO_DELETION_DAYS = 30;

/**
 * Statements close on the 1st of each month at this IST time, after the daily close (00:10) has
 * closed the month's last day. A run missed on the 1st catches up later in the month.
 */
export const STATEMENT_CLOSE_AT_IST = "00:30";

/** How often billing.alerts checks accounts that have a monthly limit. */
export const ALERTS_EVERY_MINUTES = 60;

/**
 * A month is billed only when its exact charges add up to at least this many micro-paise — half a
 * paisa, the least that rounds to a paisa. Smaller months get no statement.
 */
export const MIN_BILLABLE_MICRO_PAISE = 500_000n;

export const STATEMENTS_DEFAULT_LIMIT = 24;
export const STATEMENTS_MAX_LIMIT = 100;
