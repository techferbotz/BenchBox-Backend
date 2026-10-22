import { authService } from "../auth/service/auth.service";
import { reconcileService } from "../files/service/reconcile.service";
import { uploadsService } from "../files/service/uploads.service";
import { treeService } from "../nodes/service/tree.service";
import { outboxService } from "../outbox/service/outbox.service";
import { syncService } from "../sync/service/sync.service";
import { JobSpec } from "./scheduler";

// Every scheduled job, run by the worker. The daily ones are staggered after 03:00 IST, the quietest
// hours; trash.autoPurge runs before storage.reconcile so the reconcile sees the day's purges.
export const JOBS: JobSpec[] = [
  // Removes bytes from R2 for whatever committed a deletion: purges, replacements, ended uploads,
  // deleted accounts. Retries failures with backoff, forever.
  {
    name: "outbox.drain",
    everyMinutes: 1,
    run: () => outboxService.drain(),
    idle: (summary) => summary.startsWith("0 done, 0 continuing, 0 failed") || summary.startsWith("nothing queued"),
  },
  {
    name: "uploads.expire",
    everyMinutes: 15,
    run: (now) => uploadsService.expireStale(now),
    idle: (summary) => summary.startsWith("expired 0 "),
  },
  // The privacy page promises trash is purged after TRASH_RETENTION_DAYS.
  { name: "trash.autoPurge", dailyAtIst: "03:00", run: (now) => treeService.purgeExpiredTrash(now) },
  { name: "sync.compactTombstones", dailyAtIst: "03:30", run: (now) => syncService.compactTombstones(now) },
  { name: "sessions.purgeExpired", dailyAtIst: "04:00", run: (now) => authService.purgeExpiredSessions(now) },
  // Report-first: deletes only provable garbage; logs "[reconcile] ALERT …" for anything else.
  { name: "storage.reconcile", dailyAtIst: "05:00", run: (now) => reconcileService.run(now) },
];
