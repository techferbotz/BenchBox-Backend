// Metering policy numbers (docs/BACKEND_PLAN.md §6, §7.1). The prices themselves are data (the
// PriceBook table), not constants. PRICE_CHANGE_NOTICE_DAYS is a public promise — the Terms quote
// it — so it lives with the rule that enforces it (priceBookFor in metering.rules.ts) and the legal
// page imports it.

/**
 * Minimum notice before a price increase takes effect: an increase applies from the first month
 * that starts at least this many days after its price book was recorded, whatever date the book
 * itself names.
 */
export const PRICE_CHANGE_NOTICE_DAYS = 30;

/**
 * The daily close runs this long after midnight IST. A storage change is stamped before its
 * transaction takes the account's lock, and tree transactions time out within two minutes, so by
 * then everything stamped before midnight has committed (or never will).
 */
export const DAILY_CLOSE_AT_IST = "00:10";

/** GET /billing/usage: days per request at most. */
export const USAGE_MAX_DAYS = 366;

/** StorageEvents read per query while walking an account's log. */
export const EVENT_PAGE_SIZE = 5000;
