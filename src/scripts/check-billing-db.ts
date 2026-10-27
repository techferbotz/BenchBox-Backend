// Integration checks for metering, statements and billing alerts, against a real PostgreSQL — a
// LOCAL, disposable database only; the script refuses anything else:
//
//   npm run check:billing-db        (DATABASE_URL from .env, schema migrated, price book seeded)
//
// Storage changes go through the real choke point (MeteringTx.recordStorageChange) at chosen
// times; the clock is the script's. Push and email are in-memory fakes. The worked example's
// ₹43.27 is billed end to end: events → daily close → statement → bill-ready notification → sent.

import dotenv from "dotenv";
dotenv.config({ quiet: true });

let dbHost = "";
try {
  dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  dbHost = "";
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(dbHost)) {
  console.error("check:billing-db runs only against a LOCAL database (DATABASE_URL host must be localhost). Refusing.");
  process.exit(1);
}
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://benchbox.ferbotz.com",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeliveryState } from "@prisma/client";
import { prisma } from "../prisma/client";
import { DeliveryOutcome, EmailMessage, EmailSender, PushMessage, PushSender } from "../integrations/senders";
import { userRepository } from "../modules/account/repository/user.repository";
import { BillingService } from "../modules/billing/service/billing.service";
import { alertsService } from "../modules/billing/service/alerts.service";
import { statementsService } from "../modules/billing/service/statements.service";
import { MeteringTx, meteringRepository } from "../modules/metering/repository/metering.repository";
import { meteringService } from "../modules/metering/service/metering.service";
import { notificationRepository } from "../modules/notifications/repository/notification.repository";
import { NotificationsService } from "../modules/notifications/service/notifications.service";
import { OutboxService } from "../modules/outbox/service/outbox.service";

// ---------------------------------------------------------------- harness
let clock = new Date("2026-11-01T00:00:00+05:30");
const now = (): Date => clock;
/** An IST wall-clock time, "2026-11-15T12:00". */
const ist = (wallClock: string): Date => new Date(`${wallClock}:00+05:30`);
const GB = 1_000_000_000n;

/** A push service that answers what the test says, per token, and remembers what it was asked. */
class FakePush implements PushSender {
  sent: { tokens: string[]; message: PushMessage }[] = [];
  outcome: (token: string) => DeliveryOutcome = () => "sent";
  async send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return tokens.map((token) => {
      const outcome = this.outcome(token);
      return { token, outcome, error: outcome === "sent" ? null : `fake: ${outcome}` };
    });
  }
}
class FakeEmail implements EmailSender {
  sent: EmailMessage[] = [];
  outcome: Exclude<DeliveryOutcome, "invalid-token"> = "sent";
  async send(message: EmailMessage) {
    this.sent.push(message);
    return { outcome: this.outcome, error: this.outcome === "sent" ? null : `fake: ${this.outcome}` };
  }
}

const push = new FakePush();
const email = new FakeEmail();
const notifications = new NotificationsService({ now, push, email });
// No object store: the drain runs only notification jobs (the storage checks own the rest).
const outbox = new OutboxService({ now, store: null, notifications });
const billing = new BillingService({ now });

const RUN = Date.now().toString(36);
const createdUserIds = new Set<string>();
const tempBookIds: string[] = [];
const newUser = async (label: string): Promise<string> => {
  const user = await prisma.user.create({ data: { googleSub: `check-billing-${RUN}-${label}`, email: `${label}@example.test` } });
  createdUserIds.add(user.id);
  return user.id;
};
/** A signed-in device with notifications on. */
const addDevice = async (userId: string, pushToken: string): Promise<void> => {
  await prisma.session.create({
    data: { userId, refreshTokenHash: randomUUID(), expiresAt: new Date("2030-01-01T00:00:00Z"), pushToken },
  });
};

/** A storage change at `at`, through the real choke point. */
const change = async (userId: string, at: Date, deltaBytes: bigint): Promise<void> => {
  await prisma.$transaction((tx) => new MeteringTx(tx, userId, at).recordStorageChange(deltaBytes, "ADMIN", null));
};

const closeThrough = async (userId: string, through: string): Promise<number> => {
  const books = await meteringRepository.priceBooks();
  return meteringRepository.inAccountLock(userId, (meter) => meteringService.closeAccount(meter, through, books));
};

const usageDays = (userId: string) => prisma.usageDay.findMany({ where: { userId }, orderBy: { day: "asc" } });
const statementsOf = (userId: string) => prisma.statement.findMany({ where: { userId }, orderBy: { periodStart: "asc" } });
const notificationsOf = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => {
    assert.equal((e as { code?: string }).code, code);
    return true;
  });
};

const cleanup = async (): Promise<void> => {
  const ids = [...createdUserIds];
  // Their notifications' jobs, and jobs whose notification is gone (account deletion removes the
  // notifications; the drain would finish such a job as a no-op).
  await prisma.$executeRaw`
    DELETE FROM "OutboxJob" j WHERE j."kind" = 'SEND_NOTIFICATION' AND (
      j."payload"->>'notificationId' IN (SELECT "id"::text FROM "Notification" WHERE "userId" = ANY(${ids}::uuid[]))
      OR NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."id"::text = j."payload"->>'notificationId'))`;
  // Everything else of theirs (events, days, statements, limits, notifications, sessions) cascades.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBook.deleteMany({ where: { id: { in: tempBookIds } } });
  await prisma.$disconnect();
};

let passed = 0;
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    await cleanup();
    process.exit(1);
  }
};

// ---------------------------------------------------------------- flows
const main = async (): Promise<void> => {
  const seeded = await meteringService.priceBookAt(ist("2026-11-01T00:00"));
  assert.deepEqual(
    [seeded.storagePaisePerGbMonth, seeded.freeBytes, seeded.gstBasisPoints, seeded.minimumChargePaise],
    [250n, 2n * GB, 1800, 1000n],
    "the migration seeded the suggested defaults (₹2.50/GB-month, 2 GB free, 18% GST, ₹10 minimum)"
  );

  const example = await newUser("example");
  await check("daily close: the worked example's month goes into UsageDays; closing again writes nothing", async () => {
    await change(example, ist("2026-11-01T00:00"), 10n * GB);
    await change(example, ist("2026-11-21T00:00"), 20n * GB);
    assert.equal(await closeThrough(example, "2026-11-30"), 30);
    const days = await usageDays(example);
    assert.equal(days.length, 30);
    assert.equal(days[0]!.byteSeconds.toFixed(3), "864000000000000.000", "10 GB × 86,400 s");
    assert.deepEqual([days[0]!.chargeMicroPaise, days[29]!.chargeMicroPaise], [66_666_667n, 233_333_333n]);
    assert.equal(days.reduce((sum, day) => sum + day.chargeMicroPaise, 0n), 3_666_666_670n);
    assert.equal(days[29]!.endBytes, 30n * GB);
    const before = JSON.stringify(days, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.equal(await closeThrough(example, "2026-11-30"), 0);
    assert.match(await meteringService.closeDays(ist("2026-12-01T00:10")), /through 2026-11-30$/);
    const after = JSON.stringify(await usageDays(example), (_, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.equal(after, before, "re-running a close changes nothing");
  });

  await check("two closes racing for one account write each day once", async () => {
    const u = await newUser("race");
    await change(u, ist("2026-11-01T08:00"), 5n * GB);
    const written = await Promise.all([closeThrough(u, "2026-11-10"), closeThrough(u, "2026-11-10")]);
    assert.deepEqual(written.sort(), [0, 10]);
    assert.equal((await usageDays(u)).length, 10);
  });

  const live = await newUser("live");
  await check("summary: this month so far and projected, the same live and closed", async () => {
    await change(live, ist("2026-11-01T00:00"), 10n * GB);
    clock = ist("2026-11-15T12:00");
    const beforeClose = await billing.summary(live);
    assert.equal(await closeThrough(live, "2026-11-14"), 14);
    const summary = await billing.summary(live);
    assert.deepEqual(summary, beforeClose, "numbers from closed days equal the live ones");
    assert.deepEqual(summary.monthToDate, { subtotalPaise: "958", gstPaise: "172", carriedInPaise: "0", totalPaise: "1130" });
    assert.deepEqual(summary.projected, { subtotalPaise: "2000", gstPaise: "360", carriedInPaise: "0", totalPaise: "2360" });
    assert.deepEqual(
      [summary.month, summary.periodStart, summary.periodEnd, summary.statementDate, summary.storedBytes],
      ["2026-11", "2026-11-01", "2026-11-30", "2026-12-01", 10_000_000_000]
    );
    assert.deepEqual(summary.price, { paisePerGbMonth: "250", freeBytes: 2_000_000_000, gstPercent: "18", minimumChargePaise: "1000" });
    assert.deepEqual([summary.limitPaise, summary.limitState, summary.limitUsedPercent, summary.lastStatement], [null, null, null, null]);
  });

  await check("usage: a day per date, zeros where nothing was stored, today so far", async () => {
    const usage = await billing.usage(live, "2026-10-30", "2026-12-31");
    assert.deepEqual([usage.from, usage.to, usage.days.length], ["2026-10-30", "2026-11-15", 17], "`to` stops at today");
    assert.deepEqual(usage.days[0], { date: "2026-10-30", averageBytes: 0, peakBytes: 0, endBytes: 0, chargePaise: "0", complete: true });
    assert.deepEqual(usage.days[2], {
      date: "2026-11-01",
      averageBytes: 10_000_000_000,
      peakBytes: 10_000_000_000,
      endBytes: 10_000_000_000,
      chargePaise: "67",
      complete: true,
    });
    assert.deepEqual(usage.days[16], {
      date: "2026-11-15",
      averageBytes: 10_000_000_000,
      peakBytes: 10_000_000_000,
      endBytes: 10_000_000_000,
      chargePaise: "25",
      complete: false,
    });
    assert.deepEqual((await billing.usage(live, undefined, undefined)).days.map((day) => day.date).slice(0, 1), ["2026-11-01"]);
    assert.deepEqual((await billing.usage(live, "2026-12-01", undefined)).days, []);
    await rejectsWith(billing.usage(live, "2026-11-31", undefined), "BAD_REQUEST");
    await rejectsWith(billing.usage(live, "2025-01-01", undefined), "BAD_REQUEST");
  });

  const small = await newUser("small");
  const free = await newUser("free");
  await check("statements on the 1st: ₹43.27 billed once with a bill-ready alert; a small month is carried; a free one has none", async () => {
    await addDevice(example, `tok-example-${RUN}`);
    await change(small, ist("2026-11-01T00:00"), 3n * GB); // 1 GB-day a day above the free 2 GB
    await change(free, ist("2026-11-01T00:00"), 2n * GB); // exactly the free tier
    clock = ist("2026-12-01T00:30");
    const summary = await statementsService.closeCycle(clock);
    assert.match(summary, /^made \d+ statement\(s\)/);

    const [bill] = await statementsOf(example);
    assert.ok(bill, "the example has a statement");
    assert.deepEqual(
      [bill.status, bill.subtotalPaise, bill.gstPaise, bill.carriedInPaise, bill.totalPaise, bill.storagePaisePerGbMonth, bill.gstBasisPoints],
      ["OPEN", 3667n, 660n, 0n, 4327n, 250n, 1800]
    );
    const [carried] = await statementsOf(small);
    assert.deepEqual([carried?.status, carried?.subtotalPaise, carried?.gstPaise, carried?.totalPaise], ["CARRIED", 250n, 45n, 295n]);
    assert.deepEqual(await statementsOf(free), [], "free usage: no statement");

    const alerts = await notificationsOf(example);
    assert.deepEqual(alerts.map((n) => [n.type, n.dedupeKey, n.push, n.email]), [
      ["STATEMENT_READY", `statement:${bill.id}`, DeliveryState.PENDING, DeliveryState.PENDING],
    ]);
    assert.deepEqual(await notificationsOf(small), [], "a carried statement isn't announced");

    // Again: nothing new.
    await statementsService.closeCycle(clock);
    assert.equal((await statementsOf(example)).length, 1);
    assert.equal((await notificationsOf(example)).length, 1);

    // Sent through the outbox, to the device and the address.
    push.sent = [];
    email.sent = [];
    await outbox.drain();
    const [sent] = await notificationsOf(example);
    assert.deepEqual([sent!.push, sent!.email], [DeliveryState.SENT, DeliveryState.SENT]);
    const pushed = push.sent.find((call) => call.tokens.includes(`tok-example-${RUN}`));
    assert.equal(pushed?.message.title, "Your November bill is ₹43.27");
    assert.equal(pushed?.message.data.statementId, bill.id);
    assert.deepEqual(email.sent.filter((m) => m.to === "example@example.test").map((m) => m.subject), ["Your November bill is ₹43.27"]);
    await outbox.drain();
    assert.equal(push.sent.filter((call) => call.tokens.includes(`tok-example-${RUN}`)).length, 1, "sent once");
  });

  await check("statement endpoints: newest first, detail with GB-days, someone else's is a 404", async () => {
    const page = await billing.listStatements(example, undefined, undefined);
    assert.equal(page.items.length, 1);
    const [item] = page.items;
    assert.deepEqual([item!.month, item!.status, item!.totalPaise], ["2026-11", "open", "4327"]);
    assert.deepEqual(item!.usage, { gbDays: "500.00", freeGbDays: "60.00", billableGbDays: "440.00", billableGbMonths: "14.67" });
    assert.deepEqual([item!.paisePerGbMonth, item!.gstPercent, item!.subtotalPaise, item!.gstPaise], ["250", "18", "3667", "660"]);
    assert.deepEqual(await billing.getStatement(example, item!.id), item);
    await rejectsWith(billing.getStatement(small, item!.id), "NOT_FOUND");
    await rejectsWith(billing.getStatement(example, "not-a-uuid"), "NOT_FOUND");
    await rejectsWith(billing.listStatements(example, "garbage", undefined), "INVALID_CURSOR");
    const summary = await billing.summary(example);
    assert.equal(summary.lastStatement?.id, item!.id);
  });

  await check("carry-forward: the next statement takes the carried total in, and says where it went", async () => {
    clock = ist("2026-12-10T12:00");
    const midMonth = await billing.summary(small);
    assert.equal(midMonth.monthToDate.carriedInPaise, "295", "this month so far includes the carried total");
    await change(small, ist("2026-12-01T00:00"), 10n * GB); // a big December
    clock = ist("2027-01-01T00:30");
    await statementsService.closeCycle(clock);
    const [november, december] = await statementsOf(small);
    assert.equal(december?.status, "OPEN");
    assert.equal(december?.carriedInPaise, 295n);
    assert.equal(december?.totalPaise, december!.subtotalPaise + december!.gstPaise + 295n);
    assert.equal(november?.carriedIntoId, december?.id);
    assert.equal((await billing.summary(small)).monthToDate.carriedInPaise, "0", "carried once");
  });

  await check("alerts with a limit set directly: 80% and the projection once, 100% once, a new limit re-arms", async () => {
    const u = await newUser("alerts");
    await addDevice(u, `tok-alerts-${RUN}`);
    await change(u, ist("2026-11-01T00:00"), 10n * GB);
    await prisma.billingAccount.create({ data: { userId: u, monthlyLimitPaise: 1400n } }); // ₹14
    const keys = async () => (await notificationsOf(u)).map((n) => [n.dedupeKey.split(":")[0], n.push, n.email]);

    clock = ist("2026-11-15T12:00"); // so far ₹11.30 (80.7%), projected ₹23.60
    await alertsService.run(clock);
    assert.deepEqual(await keys(), [
      ["limit80", DeliveryState.PENDING, DeliveryState.PENDING],
      ["projected", DeliveryState.PENDING, DeliveryState.NONE],
    ]);
    await alertsService.run(clock);
    assert.equal((await notificationsOf(u)).length, 2, "nothing twice");
    const summary = await billing.summary(u);
    assert.deepEqual([summary.limitPaise, summary.limitState, summary.limitUsedPercent], ["1400", "projected_over", 80]);

    clock = ist("2026-11-20T12:00"); // so far ₹15.25: past the limit
    await alertsService.run(clock);
    assert.deepEqual((await keys()).map(([key]) => key), ["limit80", "projected", "limit100"]);
    assert.equal((await billing.summary(u)).limitState, "over");

    push.sent = [];
    await outbox.drain();
    const titles = push.sent.filter((call) => call.tokens.includes(`tok-alerts-${RUN}`)).map((call) => call.message.title);
    assert.deepEqual(titles.sort(), ["You've passed your ₹14 limit", "You've used 80% of your ₹14 limit", "Your estimated bill is above your limit"]);
    assert.ok((await notificationsOf(u)).every((n) => n.push === DeliveryState.SENT));

    await prisma.billingAccount.update({ where: { userId: u }, data: { monthlyLimitPaise: 2000n } });
    await alertsService.run(clock);
    assert.deepEqual((await keys()).map(([key]) => key), ["limit80", "projected", "limit100", "projected"], "a new limit re-arms the projection");

    // Reaching 80% and 100% at once sends only the 100% alert.
    const jump = await newUser("jump");
    await change(jump, ist("2026-11-01T00:00"), 10n * GB);
    await prisma.billingAccount.create({ data: { userId: jump, monthlyLimitPaise: 1000n } });
    await alertsService.run(clock);
    const made = (await notificationsOf(jump)).map((n) => [n.dedupeKey.split(":")[0], n.push, n.pushDetail]);
    assert.deepEqual(made.sort(), [
      ["limit100", DeliveryState.PENDING, null],
      ["limit80", DeliveryState.SKIPPED, "superseded by the 100% alert"],
      ["projected", DeliveryState.SKIPPED, "superseded by the limit being passed"],
    ]);
  });

  await check("delivery: skipped and logged without senders or a device; retried, then given up; stale tokens dropped", async () => {
    const u = await newUser("delivery");
    const make = async (key: string): Promise<string> => {
      await notificationRepository.inTransaction(u, now(), (n) =>
        n.create([{ dedupeKey: `${key}:${u}:${RUN}`, content: { type: "LIMIT_ALERT", payload: { month: "2026-11", percent: 80, limitPaise: "10000", toDatePaise: "8000" } } }])
      );
      return (await prisma.notification.findUniqueOrThrow({ where: { dedupeKey: `${key}:${u}:${RUN}` } })).id;
    };
    const row = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id } });

    // No senders configured: both channels skipped, nothing thrown.
    const unconfigured = new NotificationsService({ now, push: null, email: null });
    const a = await make("a");
    await unconfigured.deliver(a);
    assert.deepEqual([(await row(a)).push, (await row(a)).email], [DeliveryState.SKIPPED, DeliveryState.SKIPPED]);
    assert.match((await row(a)).pushDetail ?? "", /isn't configured/);

    // Configured, but no device has a token: push skipped; email sent.
    const b = await make("b");
    await notifications.deliver(b);
    assert.deepEqual([(await row(b)).push, (await row(b)).pushDetail, (await row(b)).email], [DeliveryState.SKIPPED, "no signed-in device has notifications on", DeliveryState.SENT]);

    // A failure that may pass: retried by the outbox, and given up after a day.
    await addDevice(u, `tok-delivery-${RUN}`);
    push.outcome = () => "retry";
    const c = await make("c");
    await assert.rejects(notifications.deliver(c), /will be retried/);
    assert.equal((await row(c)).push, DeliveryState.PENDING);
    assert.equal((await row(c)).email, DeliveryState.SENT, "email went; it isn't sent again");
    const sentEmails = email.sent.length;
    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    await notifications.deliver(c);
    assert.deepEqual([(await row(c)).push, email.sent.length], [DeliveryState.FAILED, sentEmails]);
    assert.match((await row(c)).pushDetail ?? "", /^gave up after 24 h/);

    // A dead token is dropped from its device.
    push.outcome = () => "invalid-token";
    const d = await make("d");
    await notifications.deliver(d);
    assert.deepEqual([(await row(d)).push, (await row(d)).pushDetail], [DeliveryState.SKIPPED, "every device's token was stale"]);
    assert.equal(await prisma.session.count({ where: { userId: u, pushToken: { not: null } } }), 0);
    push.outcome = () => "sent";

    // A rejected address fails for good.
    email.outcome = "failed";
    const e = await make("e");
    await notifications.deliver(e);
    assert.equal((await row(e)).email, DeliveryState.FAILED);
    email.outcome = "sent";
  });

  await check("the storage allowance and free bytes come from the price book; a book must start on the 1st", async () => {
    const u = await newUser("allowance");
    const roomier = await prisma.priceBook.create({
      data: { effectiveFrom: new Date("2031-03-01T00:00:00Z"), storagePaisePerGbMonth: 250n, freeBytes: 3n * GB, gstBasisPoints: 1800, minimumChargePaise: 1000n, note: `check ${RUN}` },
    });
    tempBookIds.push(roomier.id);
    assert.equal(await meteringService.storageAllowance(u, ist("2031-02-28T23:59")), 2n * GB);
    assert.equal(await meteringService.storageAllowance(u, ist("2031-03-01T00:00")), 3n * GB);
    const usage = await meteringService.usage(u, ist("2031-03-05T10:00"));
    assert.deepEqual([usage.freeBytes, usage.limitBytes], [3_000_000_000, 3_000_000_000]);
    await assert.rejects(
      prisma.priceBook.create({
        data: { effectiveFrom: new Date("2031-04-15T00:00:00Z"), storagePaisePerGbMonth: 1n, freeBytes: 1n, gstBasisPoints: 1, minimumChargePaise: 1n },
      }),
      /PriceBook_effectiveFrom_first_of_month/
    );
  });

  await check("account deletion keeps the usage and statements, drops the limit and the notifications", async () => {
    clock = ist("2027-01-05T10:00");
    await prisma.billingAccount.create({ data: { userId: example, monthlyLimitPaise: 5000n } });
    // The 30 GB as a real account holds them, in a blob, so deletion releases them.
    const blobId = randomUUID();
    await prisma.blob.create({ data: { id: blobId, userId: example, bucket: "check", objectKey: `u/${example}/${blobId}`, size: 30n * GB } });
    const daysBefore = (await usageDays(example)).length;
    const statementsBefore = await statementsOf(example);
    assert.deepEqual(statementsBefore.map((s) => s.periodStart.toISOString().slice(0, 7)), ["2026-11", "2026-12"]);
    assert.ok((await prisma.notification.count({ where: { userId: example } })) > 0);
    await userRepository.anonymiseAndSignOut(example, clock, []);
    assert.equal(await prisma.billingAccount.count({ where: { userId: example } }), 0);
    assert.equal(await prisma.notification.count({ where: { userId: example } }), 0);
    assert.equal((await statementsOf(example)).length, statementsBefore.length, "statements stay");
    // The days up to the deletion are still closed and billed; after it, nothing is stored.
    await closeThrough(example, "2027-01-06");
    const days = await usageDays(example);
    assert.ok(days.length > daysBefore);
    assert.deepEqual([days[days.length - 1]!.day.toISOString().slice(0, 10), days[days.length - 1]!.endBytes], ["2027-01-05", 0n]);
  });

  await check("jobs: metering.closeDay daily at 00:10, billing.closeCycle monthly at 00:30, billing.alerts hourly", async () => {
    const { JOBS } = await import("../modules/jobs/jobs");
    const names = JOBS.map((job) => `${job.name}:${job.everyMinutes ?? job.dailyAtIst ?? `monthly ${job.monthlyAtIst}`}`);
    for (const expected of ["metering.closeDay:00:10", "billing.closeCycle:monthly 00:30", "billing.alerts:60", "outbox.drain:1"]) {
      assert.ok(names.includes(expected), `${expected} in ${names.join(", ")}`);
    }
  });

  await cleanup();
  console.log(`\ncheck:billing-db — ${passed} checks passed`);
};

void main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
