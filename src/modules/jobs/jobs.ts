import { authService } from "../auth/service/auth.service";
import { ALERTS_EVERY_MINUTES, STATEMENT_CLOSE_AT_IST } from "../billing/billing.policy";
import { alertsService } from "../billing/service/alerts.service";
import { statementsService } from "../billing/service/statements.service";
import { reconcileService } from "../files/service/reconcile.service";
import { uploadsService } from "../files/service/uploads.service";
import { DAILY_CLOSE_AT_IST } from "../metering/metering.policy";
import { meteringService } from "../metering/service/metering.service";
import { treeService } from "../nodes/service/tree.service";
import { outboxService } from "../outbox/service/outbox.service";
import { syncService } from "../sync/service/sync.service";
import { JobSpec } from "./scheduler";

// Every scheduled job, run by the worker. Billing runs just after midnight IST — the day's close at
// 00:10, then on the 1st the month's statements at 00:30 — and the housekeeping is staggered after
// 03:00, the quietest hours; trash.autoPurge runs before storage.reconcile so the reconcile sees
// the day's purges.
export const JOBS: JobSpec[] = [
  // Removes bytes from R2 for whatever committed a deletion: purges, replacements, ended uploads,
  // deleted accounts; and sends notifications. Retries failures with backoff.
  {
    name: "outbox.drain",
    everyMinutes: 1,
    run: () => outboxService.drain(),
    idle: (summary) => summary.startsWith("0 done, 0 continuing, 0 failed"),
  },
  {
    name: "uploads.expire",
    everyMinutes: 15,
    run: (now) => uploadsService.expireStale(now),
    idle: (summary) => summary.startsWith("expired 0 "),
  },
  // Yesterday's storage, from the StorageEvent log, priced into UsageDays.
  { name: "metering.closeDay", dailyAtIst: DAILY_CLOSE_AT_IST, run: (now) => meteringService.closeDays(now) },
  // Last month's statements (and any month an outage skipped).
  { name: "billing.closeCycle", monthlyAtIst: STATEMENT_CLOSE_AT_IST, run: (now) => statementsService.closeCycle(now) },
  // 80% / 100% of the monthly limit, and a projection above it. Only accounts with a limit.
  {
    name: "billing.alerts",
    everyMinutes: ALERTS_EVERY_MINUTES,
    run: (now) => alertsService.run(now),
    idle: (summary) => summary.endsWith(": 0 new alert(s)"),
  },
  // The privacy page promises trash is purged after TRASH_RETENTION_DAYS.
  { name: "trash.autoPurge", dailyAtIst: "03:00", run: (now) => treeService.purgeExpiredTrash(now) },
  { name: "sync.compactTombstones", dailyAtIst: "03:30", run: (now) => syncService.compactTombstones(now) },
  { name: "sessions.purgeExpired", dailyAtIst: "04:00", run: (now) => authService.purgeExpiredSessions(now) },
  // Report-first: deletes only provable garbage; logs "[reconcile] ALERT …" for anything else.
  { name: "storage.reconcile", dailyAtIst: "05:00", run: (now) => reconcileService.run(now) },
];
