// Fixture checks for metering and billing (HOA protocol 04: small ts-node scripts, no test
// framework), in the style of Billanta's check:money. No database, no network:
//
//   npm run check:metering
//
// Pins docs/BACKEND_PLAN.md §6's worked example (₹43.27) and its edge cases — an upload at 23:59, a
// purge mid-day, a price change at a month's start, a 31-day month, the free-tier boundary, a day
// with no events — plus re-running a close, the IST calendar, money rounding, the statement and
// alert rules, the notification copy and the senders' configuration. The flows against a database
// are check:billing-db.

// config/env.ts fails fast on missing REQUIRED vars: placeholders for any that are missing, set
// BEFORE the imports below load it (tsc keeps statement order in CommonJS output). No FCM_/SES_
// variables: the senders stay unconfigured, as on a fresh box.
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://benchbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}
const SENDER_KEYS = ["FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY", "SES_REGION", "SES_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"];
for (const key of SENDER_KEYS) delete process.env[key];

import assert from "node:assert/strict";
import { formatRupees, gstOn, microToPaise, percentOf, percentString, ratioString, reachesPercent, storageChargeMicroPaise } from "../common/money";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  isDate,
  istDate,
  istDayEnd,
  istDayStart,
  monthEnd,
  monthName,
} from "../common/time";
import { config, parseFcmConfig, parseSesConfig } from "../config/env";
import { classifyFcmError } from "../integrations/fcm";
import { classifySesError, redactAddresses } from "../integrations/ses";
import { LIMIT_ALERT_PERCENTS } from "../modules/billing/billing.policy";
import { billTotals, dueAlerts, limitStateOf, statementStatusFor } from "../modules/billing/billing.rules";
import { dueMonthlyPeriod, duePeriod } from "../modules/jobs/jobs.schedule";
import { PRICE_CHANGE_NOTICE_DAYS } from "../modules/metering/metering.policy";
import {
  billableByteMs,
  byteMsToSeconds,
  dayChargeMicroPaise,
  firstMonthAfterNotice,
  MeteredDay,
  meterDays,
  MeterEvent,
  PriceBookRow,
  priceBookFor,
  projectMonth,
  secondsToByteMs,
} from "../modules/metering/metering.rules";
import { CHANNELS, parseNotification, renderNotification } from "../modules/notifications/notifications.messages";
import { notificationJob, parseOutboxJob } from "../modules/outbox/outbox.jobs";

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
};

// ---------------------------------------------------------------- fixtures
const GB = 1_000_000_000n;
const HOUR_MS = 3_600_000n;
const DAY_MS = 24n * HOUR_MS;
/** An IST wall-clock time, "2026-11-01T00:00" or "2026-11-01T00:00:05". */
const ist = (wallClock: string): Date => new Date(`${wallClock}${wallClock.length === 16 ? ":00" : ""}+05:30`);

const book = (effectiveFrom: string, paise: bigint, createdAt: string, freeBytes = 2n * GB): PriceBookRow => ({
  id: `book-${effectiveFrom}`,
  effectiveFrom,
  storagePaisePerGbMonth: paise,
  freeBytes,
  gstBasisPoints: 1800,
  minimumChargePaise: 1000n,
  createdAt: new Date(createdAt),
});
/** The seeded suggested defaults: ₹2.50 per GB-month, 2 GB free, 18% GST, ₹10 minimum. */
const DEFAULTS = book("2026-10-01", 250n, "2026-09-01T00:00:00Z");

let nextId = 1n;
const event = (at: Date, totalAfter: bigint): MeterEvent => ({ id: nextId++, at, totalAfter });
const fresh = { day: null, level: 0n, lastEventId: 0n };

const charges = (days: readonly MeteredDay[], books: readonly PriceBookRow[] = [DEFAULTS]): bigint[] =>
  days.map((day) => dayChargeMicroPaise(day.day, day.byteMs, priceBookFor(books, day.day.slice(0, 7))!));
const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

const main = async (): Promise<void> => {
  // ---------------------------------------------------------------- the calendar and money
  await check("IST: a day is 18:30 UTC to 18:30 UTC; months know their length", () => {
    assert.equal(istDayStart("2026-10-27").toISOString(), "2026-10-26T18:30:00.000Z");
    assert.equal(istDayEnd("2026-10-31").toISOString(), "2026-10-31T18:30:00.000Z");
    assert.equal(istDate(new Date("2026-10-26T18:29:59.999Z")), "2026-10-26");
    assert.equal(istDate(new Date("2026-10-26T18:30:00.000Z")), "2026-10-27");
    assert.deepEqual(["2026-10", "2026-11", "2027-02", "2028-02"].map(daysInMonth), [31, 30, 28, 29]);
    assert.deepEqual([addDays("2026-10-31", 1), addMonths("2026-12", 1), addMonths("2027-01", -1)], ["2026-11-01", "2027-01", "2026-12"]);
    assert.deepEqual([monthEnd("2028-02"), monthName("2026-10")], ["2028-02-29", "October 2026"]);
    assert.equal(daysBetween("2026-11-15", "2026-11-30"), 15);
    assert.deepEqual(["2026-10-31", "2026-02-30", "2026-1-01", 20261031].map(isDate), [true, false, false, false]);
  });

  await check("money: half-up rounding, GST on the rounded subtotal, rupees with Indian grouping", () => {
    assert.equal(microToPaise(3_666_666_670n), 3667n);
    assert.equal(microToPaise(500_000n), 1n, "half a paisa rounds up");
    assert.equal(microToPaise(499_999n), 0n);
    assert.equal(gstOn(3667n, 1800), 660n, "660.06 → 660");
    assert.equal(gstOn(3n, 1800), 1n, "0.54 → 1");
    assert.equal(gstOn(25n, 1800), 5n, "4.5 → 5 (half-up)");
    assert.equal(storageChargeMicroPaise(0n, 250n, 30), 0n);
    assert.deepEqual([formatRupees(4327n), formatRupees(5n), formatRupees(10_000_000n), formatRupees(1_234_567_89n)], ["₹43.27", "₹0.05", "₹1,00,000.00", "₹12,34,567.89"]);
    assert.deepEqual([formatRupees(10_000n, { wholeRupees: true }), formatRupees(10_050n, { wholeRupees: true })], ["₹100", "₹100.50"]);
    assert.deepEqual([percentString(1800), percentString(1250)], ["18", "12.5"]);
    assert.deepEqual([reachesPercent(7_999n, 10_000n, 80), reachesPercent(8_000n, 10_000n, 80), percentOf(8_410n, 10_000n)], [false, true, 84]);
    assert.equal(ratioString(440n, 30n, 2), "14.67");
    assert.deepEqual([byteMsToSeconds(1_500n), byteMsToSeconds(7n), secondsToByteMs("1.5"), secondsToByteMs("12.345"), secondsToByteMs("8")], ["1.500", "0.007", 1_500n, 12_345n, 8_000n]);
  });

  // ---------------------------------------------------------------- the worked example (§6)
  await check("worked example: 10 GB for 20 days, then 30 GB for 10 days, in a 30-day month = ₹43.27", () => {
    const events = [event(ist("2026-11-01T00:00"), 10n * GB), event(ist("2026-11-21T00:00"), 30n * GB)];
    const { days, level } = meterDays(fresh, events, "2026-11-30");
    assert.equal(days.length, 30);
    assert.equal(level, 30n * GB);
    const usage = sum(days.map((day) => day.byteMs));
    const billable = sum(days.map((day) => billableByteMs(day.byteMs, DEFAULTS)));
    const gbDay = GB * DAY_MS;
    assert.deepEqual([usage / gbDay, billable / gbDay], [500n, 440n], "500 GB-days, 440 above the free tier");
    assert.equal(ratioString(billable, gbDay * 30n, 2), "14.67", "≈ 14.67 GB-months");
    const totals = billTotals(sum(charges(days)), DEFAULTS.gstBasisPoints, 0n);
    assert.deepEqual(totals, { subtotalPaise: 3667n, gstPaise: 660n, carriedInPaise: 0n, totalPaise: 4327n });
    assert.equal(statementStatusFor(totals.totalPaise, DEFAULTS.minimumChargePaise), "OPEN");
  });

  // ---------------------------------------------------------------- edge cases (§6)
  await check("an upload at 23:59 counts one minute that day, then whole days", () => {
    const { days } = meterDays(fresh, [event(ist("2026-11-10T23:59"), 10n * GB)], "2026-11-11");
    assert.deepEqual(days.map((day) => [day.day, day.byteMs, day.peakBytes]), [
      ["2026-11-10", 10n * GB * 60_000n, 10n * GB],
      ["2026-11-11", 10n * GB * DAY_MS, 10n * GB],
    ]);
    assert.deepEqual(charges(days), [0n, 66_666_667n], "a minute of 10 GB is inside the day's free 2 GB-days");
  });

  await check("a purge mid-day stops the charge at that moment; an empty day after it has no row", () => {
    const { days, level } = meterDays({ day: "2026-11-09", level: 10n * GB, lastEventId: 5n }, [{ id: 6n, at: ist("2026-11-10T12:00"), totalAfter: 0n }], "2026-11-11");
    assert.equal(days.length, 1);
    const [day] = days;
    assert.deepEqual([day!.day, day!.byteMs, day!.endBytes, day!.lastEventId, level], ["2026-11-10", 10n * GB * 12n * HOUR_MS, 0n, 6n, 0n]);
    assert.deepEqual(charges(days), [25_000_000n], "5 GB-days − 2 free = 3 GB-days × ₹2.50 ÷ 30 = 25 paise exactly");
  });

  await check(`a price change at the start of a month, and ${PRICE_CHANGE_NOTICE_DAYS} days' notice for increases`, () => {
    const books = [
      DEFAULTS, // October: ₹2.50
      book("2026-11-01", 300n, "2026-09-15T00:00:00Z"), // an increase recorded with notice: November
      book("2026-12-01", 400n, "2026-11-20T00:00:00Z"), // an increase recorded late: waits until January
      book("2027-02-01", 200n, "2027-01-25T00:00:00Z"), // a decrease needs no notice
    ];
    const priceIn = (month: string): bigint | undefined => priceBookFor(books, month)?.storagePaisePerGbMonth;
    assert.deepEqual(["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"].map(priceIn), [undefined, 250n, 300n, 300n, 400n, 200n]);
    assert.equal(firstMonthAfterNotice(new Date("2026-11-20T00:00:00Z")), "2027-01");
    // Exactly the notice before a month starts is enough; a moment less isn't.
    assert.equal(firstMonthAfterNotice(new Date(ist("2026-11-01T00:00").getTime() - PRICE_CHANGE_NOTICE_DAYS * 86_400_000)), "2026-11");
    assert.equal(firstMonthAfterNotice(new Date(ist("2026-11-01T00:00").getTime() - PRICE_CHANGE_NOTICE_DAYS * 86_400_000 + 1)), "2026-12");
    // A smaller free allowance is an increase too.
    const lessFree = [DEFAULTS, book("2026-11-01", 250n, "2026-10-20T00:00:00Z", 1n * GB)];
    assert.equal(priceBookFor(lessFree, "2026-11")?.freeBytes, 2n * GB);

    // Flat 10 GB across the change: Oct 31 is priced at October's rate over 31 days, Nov 1 at November's over 30.
    const { days } = meterDays({ day: "2026-10-30", level: 10n * GB, lastEventId: 1n }, [], "2026-11-01");
    assert.deepEqual(charges(days, books), [64_516_129n, 80_000_000n]);
  });

  await check("a 31-day month: flat usage costs exactly the monthly price", () => {
    const { days } = meterDays(fresh, [event(ist("2026-10-01T00:00"), 10n * GB)], "2026-10-31");
    assert.equal(days.length, 31);
    assert.equal(billTotals(sum(charges(days)), 1800, 0n).subtotalPaise, 2000n, "8 GB-months × ₹2.50");
  });

  await check("the free-tier boundary: 2 GB all day is free; so is 4 GB for half a day; a byte-day more is not", () => {
    const at = (gb: bigint, hours: bigint): bigint => dayChargeMicroPaise("2026-11-02", gb * GB * hours * HOUR_MS, DEFAULTS);
    assert.deepEqual([at(2n, 24n), at(4n, 12n), at(3n, 24n)], [0n, 0n, 8_333_333n]);
    const { days } = meterDays(fresh, [event(ist("2026-11-02T00:00"), 4n * GB), event(ist("2026-11-02T12:00"), 0n)], "2026-11-02");
    assert.deepEqual(charges(days), [0n]);
  });

  await check("a day with no events carries the level; re-running a close writes nothing", () => {
    const state = { day: "2026-11-01", level: 10n * GB, lastEventId: 7n };
    const { days } = meterDays(state, [], "2026-11-03");
    assert.deepEqual(days.map((day) => [day.day, day.byteMs, day.lastEventId, day.complete]), [
      ["2026-11-02", 10n * GB * DAY_MS, 7n, true],
      ["2026-11-03", 10n * GB * DAY_MS, 7n, true],
    ]);
    const last = days[days.length - 1]!;
    assert.deepEqual(meterDays({ day: last.day, level: last.endBytes, lastEventId: last.lastEventId }, [], "2026-11-03").days, []);
  });

  await check("the log never runs backwards: a later commit with an earlier clock takes effect after its predecessor", () => {
    const events = [{ id: 1n, at: ist("2026-11-05T10:00:05"), totalAfter: 10n * GB }, { id: 2n, at: ist("2026-11-05T10:00:03"), totalAfter: 20n * GB }];
    const [day] = meterDays(fresh, events, "2026-11-05").days;
    const after = BigInt(istDayEnd("2026-11-05").getTime() - ist("2026-11-05T10:00:05").getTime());
    assert.deepEqual([day!.byteMs, day!.peakBytes], [20n * GB * after, 20n * GB]);
  });

  await check("an event that committed after its day closed counts from the next day's start", () => {
    const late = { id: 11n, at: ist("2026-11-05T23:58"), totalAfter: 5n * GB };
    const { days } = meterDays({ day: "2026-11-05", level: 1n * GB, lastEventId: 10n }, [late], "2026-11-06");
    assert.deepEqual(days.map((day) => [day.day, day.byteMs, day.lastEventId]), [["2026-11-06", 5n * GB * DAY_MS, 11n]]);
  });

  await check("nothing stored: the walk jumps to the next event; an event after the walk waits", () => {
    const { days } = meterDays({ day: "2026-11-01", level: 0n, lastEventId: 3n }, [{ id: 4n, at: ist("2026-11-06T12:00"), totalAfter: GB }], "2026-11-08");
    assert.deepEqual(days.map((day) => day.day), ["2026-11-06", "2026-11-07", "2026-11-08"]);
    assert.equal(days[0]!.byteMs, GB * 12n * HOUR_MS);
    const waiting = meterDays({ day: "2026-11-01", level: 2n * GB, lastEventId: 3n }, [{ id: 4n, at: ist("2026-11-03T00:00"), totalAfter: 0n }], "2026-11-02");
    assert.deepEqual(waiting.days.map((day) => [day.day, day.lastEventId, day.endBytes]), [["2026-11-02", 3n, 2n * GB]], "the event belongs to the 3rd");
  });

  // ---------------------------------------------------------------- live numbers
  await check("month-to-date and projection: 10 GB since the 1st, at noon on the 15th of a 30-day month", () => {
    const now = ist("2026-11-15T12:00");
    const closed = Array.from({ length: 14 }, (_, i) => ({ day: addDays("2026-11-01", i), byteMs: 10n * GB * DAY_MS, chargeMicroPaise: 66_666_667n }));
    const live = meterDays({ day: "2026-11-14", level: 10n * GB, lastEventId: 1n }, [], "2026-11-15", now);
    assert.deepEqual(live.days.map((day) => [day.day, day.byteMs, day.complete]), [["2026-11-15", 10n * GB * 12n * HOUR_MS, false]]);
    const today = live.days.map((day) => ({ ...day, chargeMicroPaise: dayChargeMicroPaise(day.day, day.byteMs, DEFAULTS) }));
    assert.equal(today[0]!.chargeMicroPaise, 25_000_000n, "today so far gets the whole day's free allowance");
    const projection = projectMonth({ month: "2026-11", book: DEFAULTS, days: [...closed, ...today], level: live.level, now });
    assert.deepEqual(projection, { toDateMicroPaise: 958_333_338n, projectedMicroPaise: 2_000_000_010n });
    assert.deepEqual(billTotals(projection.toDateMicroPaise, 1800, 0n), { subtotalPaise: 958n, gstPaise: 172n, carriedInPaise: 0n, totalPaise: 1130n });
    assert.equal(billTotals(projection.projectedMicroPaise, 1800, 0n).totalPaise, 2360n, "₹20.00 + ₹3.60: a flat month");
    // A month that has ended projects to what it was.
    assert.deepEqual(projectMonth({ month: "2026-10", book: DEFAULTS, days: [], level: 10n * GB, now }), { toDateMicroPaise: 0n, projectedMicroPaise: 0n });
  });

  // ---------------------------------------------------------------- statements and alerts
  await check("statements: below the minimum charge a bill is carried; the next one takes it in", () => {
    assert.deepEqual([statementStatusFor(999n, 1000n), statementStatusFor(1000n, 1000n)], ["CARRIED", "OPEN"]);
    const small = billTotals(520_000_000n, 1800, 0n); // ₹5.20 + 94 paise GST
    assert.deepEqual([small.totalPaise, statementStatusFor(small.totalPaise, 1000n)], [614n, "CARRIED"]);
    assert.equal(billTotals(1_234_000_000n, 1800, small.totalPaise).totalPaise, 1234n + 222n + 614n);
  });

  await check(`usage alerts at ${LIMIT_ALERT_PERCENTS.join("% and ")}% of the limit, and above it projected — keyed by month and limit`, () => {
    const base = { userId: "u1", month: "2026-11", limitPaise: 10_000n };
    const kinds = (toDatePaise: bigint, projectedPaise: bigint) =>
      dueAlerts({ ...base, toDatePaise, projectedPaise }).map((alert) => [alert.dedupeKey, alert.supersededBy ?? null]);
    assert.deepEqual(kinds(7_999n, 9_000n), []);
    assert.deepEqual(kinds(8_000n, 9_000n), [["limit80:u1:2026-11:10000", null]]);
    assert.deepEqual(kinds(10_000n, 12_000n), [
      ["limit80:u1:2026-11:10000", "the 100% alert"],
      ["limit100:u1:2026-11:10000", null],
      ["projected:u1:2026-11:10000", "the limit being passed"],
    ]);
    assert.deepEqual(kinds(5_000n, 10_001n), [["projected:u1:2026-11:10000", null]]);
    assert.deepEqual(kinds(5_000n, 10_000n), [], "projected exactly at the limit is not above it");
    assert.deepEqual(dueAlerts({ ...base, limitPaise: 0n, toDatePaise: 1n, projectedPaise: 1n }), []);
    assert.deepEqual([limitStateOf(9_999n, 10_000n, 10_000n), limitStateOf(9_999n, 10_001n, 10_000n), limitStateOf(10_000n, 10_000n, 10_000n)], [
      "on_track",
      "projected_over",
      "over",
    ]);
  });

  await check("notification copy, data and channels", () => {
    const eighty = renderNotification("n1", { type: "LIMIT_ALERT", payload: { month: "2026-10", percent: 80, limitPaise: "10000", toDatePaise: "8410" } });
    assert.deepEqual([eighty.push.title, eighty.push.body], ["You've used 80% of your ₹100 limit", "₹84.10 so far in October."]);
    assert.deepEqual(eighty.push.data, { type: "limit_alert", notificationId: "n1", month: "2026-10", percent: "80" });
    const passedLimit = renderNotification("n2", { type: "LIMIT_ALERT", payload: { month: "2026-10", percent: 100, limitPaise: "10000", toDatePaise: "11240" } });
    assert.deepEqual([passedLimit.push.title, passedLimit.push.body], ["You've passed your ₹100 limit", "₹112.40 so far in October. Uploads keep working."]);
    const projected = renderNotification("n3", { type: "PROJECTED_OVER_LIMIT", payload: { month: "2026-10", limitPaise: "10000", projectedPaise: "13100" } });
    assert.deepEqual([projected.push.title, projected.push.data.type], ["Your estimated bill is above your limit", "projected_over_limit"]);
    const statementId = "3b6f2c1e-0c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const bill = renderNotification("n4", { type: "STATEMENT_READY", payload: { month: "2026-10", statementId, totalPaise: "4327" } });
    assert.deepEqual([bill.push.title, bill.push.data.statementId, bill.email.subject], ["Your October bill is ₹43.27", statementId, "Your October bill is ₹43.27"]);
    assert.ok(bill.email.html.includes("Your October bill is ₹43.27") && bill.email.text.includes("see the statement"));
    assert.deepEqual([CHANNELS.LIMIT_ALERT, CHANNELS.PROJECTED_OVER_LIMIT, CHANNELS.STATEMENT_READY], [
      { push: true, email: true },
      { push: true, email: false },
      { push: true, email: true },
    ]);
    assert.deepEqual(parseNotification("STATEMENT_READY", { month: "2026-10", statementId, totalPaise: "4327" }).type, "STATEMENT_READY");
    assert.throws(() => parseNotification("LIMIT_ALERT", { month: "2026-13", percent: 80, limitPaise: "1", toDatePaise: "1" }));
    assert.throws(() => parseNotification("SOMETHING_ELSE", {}));
  });

  // ---------------------------------------------------------------- senders and jobs
  await check("senders: none configured means skip; a partial set refuses to boot; errors are classified", () => {
    assert.deepEqual([config.fcm, config.ses], [null, null]);
    const withEnv = (vars: Record<string, string>, fn: () => void): void => {
      Object.assign(process.env, vars);
      try {
        fn();
      } finally {
        for (const key of SENDER_KEYS) delete process.env[key];
      }
    };
    withEnv({ FCM_PROJECT_ID: "benchbox-75a31" }, () => assert.throws(parseFcmConfig, /FCM is partly configured.*missing FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY/));
    withEnv({ SES_REGION: "ap-south-1", SES_FROM: "billing@ferbotz.com" }, () => assert.throws(parseSesConfig, /SES is partly configured/));
    withEnv(
      {
        FCM_PROJECT_ID: "benchbox-75a31",
        FCM_CLIENT_EMAIL: "push@benchbox-75a31.iam.gserviceaccount.com",
        FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n",
      },
      () => assert.equal(parseFcmConfig()?.privateKey, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", "literal \\n become newlines")
    );
    withEnv(
      {
        FCM_PROJECT_ID: "benchbox-75a31",
        FCM_CLIENT_EMAIL: "push@benchbox-75a31.iam.gserviceaccount.com",
        FCM_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n"',
      },
      () => assert.equal(parseFcmConfig()?.privateKey, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", "quotes an env-file reader kept are dropped")
    );
    withEnv(
      { SES_REGION: "ap-south-1", SES_FROM: "BenchBox <billing@ferbotz.com>", SES_ACCESS_KEY_ID: "AKIA0000", SES_SECRET_ACCESS_KEY: "s".repeat(40) },
      () => assert.equal(parseSesConfig()?.from, "BenchBox <billing@ferbotz.com>")
    );
    withEnv({ SES_REGION: "mumbai", SES_FROM: "x@y.z", SES_ACCESS_KEY_ID: "a", SES_SECRET_ACCESS_KEY: "s".repeat(40) }, () =>
      assert.throws(parseSesConfig, /SES_REGION/)
    );
    assert.deepEqual(
      ["messaging/registration-token-not-registered", "messaging/mismatched-credential", "messaging/server-unavailable", "messaging/invalid-argument", undefined].map(classifyFcmError),
      ["invalid-token", "invalid-token", "retry", "failed", "retry"]
    );
    assert.deepEqual(["MessageRejected", "TooManyRequestsException", undefined].map(classifySesError), ["failed", "retry", "retry"]);
    assert.equal(redactAddresses("MessageRejected: identities failed the check: asha.verma@gmail.com"), "MessageRejected: identities failed the check: <address>");
  });

  await check("jobs: the daily close at 00:10 IST; statements monthly on the 1st at 00:30; notifications through the outbox", () => {
    assert.equal(duePeriod("00:10", ist("2026-11-01T00:09")), null);
    assert.equal(duePeriod("00:10", ist("2026-11-01T00:10")), "2026-11-01");
    assert.equal(dueMonthlyPeriod("00:30", ist("2026-11-01T00:29")), null);
    assert.equal(dueMonthlyPeriod("00:30", ist("2026-11-01T00:30")), "2026-11");
    assert.equal(dueMonthlyPeriod("00:30", ist("2026-11-17T09:00")), "2026-11", "a missed run catches up later in the month");
    assert.equal(dueMonthlyPeriod("00:30", ist("2026-10-31T23:59")), "2026-10");
    assert.throws(() => dueMonthlyPeriod("half past", new Date()));
    const id = "3b6f2c1e-0c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const job = notificationJob(id, ist("2026-11-01T00:30"));
    assert.deepEqual(parseOutboxJob(job.kind, job.payload), { kind: "SEND_NOTIFICATION", payload: { notificationId: id } });
    assert.throws(() => parseOutboxJob("SEND_NOTIFICATION", { notificationId: "not-a-uuid" }));
  });

  console.log(`\ncheck:metering — ${passed} checks passed`);
};

void main();
