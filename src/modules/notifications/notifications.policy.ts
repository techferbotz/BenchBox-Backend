// Notification delivery policy (docs/BACKEND_PLAN.md §7.4).

/**
 * A channel whose sending keeps failing with errors that may pass (outages, rate limits) is
 * retried by the outbox, with backoff, for this long after the notification was made; then it is
 * given up as FAILED. An alert a day late has stopped being news.
 */
export const NOTIFICATION_RETRY_HOURS = 24;
