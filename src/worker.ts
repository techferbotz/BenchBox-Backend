import { config } from "./config/env"; // validate the environment first: a bad .env fails the worker's boot too
import { JOBS } from "./modules/jobs/jobs";
import { describeSchedule, startScheduler } from "./modules/jobs/scheduler";
import { disconnectDatabase } from "./prisma/client";

// The worker (deviation D5): the `worker` compose service, same image as the app, running scheduled
// jobs. The API process never runs jobs.

const scheduler = startScheduler(JOBS);
console.log(`BenchBox worker started: ${JOBS.map((job) => `${job.name} ${describeSchedule(job)}`).join(", ")}`);
// Billing alerts are recorded either way; a channel without credentials is skipped (and logged per alert).
console.log(
  `BenchBox worker notifications: push ${config.fcm ? "via FCM" : "not configured (FCM_* unset): skipped"}, ` +
    `email ${config.ses ? "via SES" : "not configured (SES_* unset): skipped"}`
);

const shutdown = (signal: string): void => {
  console.log(`BenchBox worker stopping (${signal})`);
  scheduler.stop();
  // A job interrupted here stays RUNNING and is claimed again once stale; every job is idempotent.
  void disconnectDatabase().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
