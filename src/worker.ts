import "./config/env"; // validate the environment first: a bad .env fails the worker's boot too
import { JOBS } from "./modules/jobs/jobs";
import { describeSchedule, startScheduler } from "./modules/jobs/scheduler";
import { disconnectDatabase } from "./prisma/client";

// The worker (deviation D5): the `worker` compose service, same image as the app, running scheduled
// jobs. The API process never runs jobs.

const scheduler = startScheduler(JOBS);
console.log(`BenchBox worker started: ${JOBS.map((job) => `${job.name} ${describeSchedule(job)}`).join(", ")}`);

const shutdown = (signal: string): void => {
  console.log(`BenchBox worker stopping (${signal})`);
  scheduler.stop();
  // A job interrupted here stays RUNNING and is claimed again once stale; every job is idempotent.
  void disconnectDatabase().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
