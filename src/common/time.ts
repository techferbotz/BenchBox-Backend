// India time (IST) for billing days and months (docs/BACKEND_PLAN.md §7.2). India keeps one fixed
// offset, +05:30, with no daylight saving, so every IST calendar date is exactly one 24-hour span of
// UTC. Timestamps are stored in UTC; an IST date travels as "YYYY-MM-DD" and a month as "YYYY-MM",
// strings that sort and compare as plain strings. Pure: no clock of its own (check:metering pins it).

/** India is UTC+05:30 all year. */
export const IST_OFFSET_MINUTES = 330;

export const DAY_MS = 24 * 60 * 60 * 1000;

const OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const utcMidnight = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

/** Whether `value` is a real calendar date, "YYYY-MM-DD". */
export const isDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && new Date(utcMidnight(value)).toISOString().startsWith(value);

/** The IST calendar date an instant falls on. */
export const istDate = (instant: Date): string => new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);

/** The instant an IST date begins: its midnight, which is 18:30 UTC the day before. */
export const istDayStart = (date: string): Date => new Date(utcMidnight(date) - OFFSET_MS);

/** The instant an IST date ends (the next one begins). */
export const istDayEnd = (date: string): Date => new Date(utcMidnight(date) - OFFSET_MS + DAY_MS);

export const addDays = (date: string, days: number): string =>
  new Date(utcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);

/** The month a date is in, "YYYY-MM". */
export const monthOf = (date: string): string => date.slice(0, 7);

const monthParts = (month: string): [number, number] => {
  const [year, mon] = month.split("-").map(Number);
  return [year!, mon!];
};

export const daysInMonth = (month: string): number => {
  const [year, mon] = monthParts(month);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
};

/** The first date of a month. */
export const monthStart = (month: string): string => `${month}-01`;

/** The last date of a month. */
export const monthEnd = (month: string): string => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;

export const addMonths = (month: string, months: number): string => {
  const [year, mon] = monthParts(month);
  return new Date(Date.UTC(year, mon - 1 + months, 1)).toISOString().slice(0, 7);
};

/** "October 2026", for messages. */
export const monthName = (month: string): string => {
  const [year, mon] = monthParts(month);
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};

/**
 * A DATE column's value as Prisma hands it over (midnight UTC of that calendar date) and back. The
 * date is a calendar date, not an instant: never pass these Dates to istDate().
 */
export const dateColumn = (date: string): Date => new Date(utcMidnight(date));
export const fromDateColumn = (value: Date): string => value.toISOString().slice(0, 10);
