import Decimal from "decimal.js";
import { DAY_MS } from "./time";

// ALL money arithmetic (HOA protocol 04, Billanta's MONEY.md): integer paise in BigInt, decimal.js
// for every division, half-up rounding, strings on the wire. Exact storage charges are kept in
// micro-paise (millionths of a paisa) and a statement rounds to paise once (docs/BACKEND_PLAN.md §6,
// §7.2). Nothing here reads a clock or the database: check:metering pins it.

/** decimal.js with room to spare (a petabyte-month in byte-milliseconds has ~25 digits) and half-up rounding. */
const Exact = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });

const exact = (value: bigint | number): Decimal => new Exact(value.toString());
/** Rounded half-up to a whole number (toFixed rounds with the clone's rounding mode). */
const whole = (value: Decimal): bigint => BigInt(value.toFixed(0));

export const MICRO_PAISE_PER_PAISA = 1_000_000n;
/** 1 GB = 10⁹ bytes, the unit phones show sizes in (docs/BACKEND_PLAN.md §6). */
export const BYTES_PER_GB = 1_000_000_000n;

/**
 * The exact charge, in micro-paise, for storage of `chargeableByteMs` (byte-milliseconds above the
 * free allowance) at `paisePerGbMonth`, in a month of `daysInMonth` days:
 *
 *   GB-days × price per GB-month ÷ days in this month
 *
 * Pricing each day by its own month's length makes flat usage cost exactly the monthly price in
 * every month. Rounded half-up to a whole micro-paisa; a statement rounds the month's sum once.
 */
export const storageChargeMicroPaise = (chargeableByteMs: bigint, paisePerGbMonth: bigint, daysInMonth: number): bigint => {
  if (chargeableByteMs <= 0n) return 0n;
  const microPaise = exact(chargeableByteMs)
    .mul(exact(paisePerGbMonth))
    .mul(exact(MICRO_PAISE_PER_PAISA))
    .div(exact(BYTES_PER_GB).mul(DAY_MS).mul(daysInMonth));
  return whole(microPaise);
};

/** Micro-paise to paise, half-up: the statement's one rounding. */
export const microToPaise = (microPaise: bigint): bigint => whole(exact(microPaise).div(exact(MICRO_PAISE_PER_PAISA)));

/** GST on an amount, half-up to the paisa. `basisPoints`: 1800 = 18%. */
export const gstOn = (paise: bigint, basisPoints: number): bigint => whole(exact(paise).mul(basisPoints).div(10_000));

/** A rate in basis points as a percentage for display: 1800 → "18", 1250 → "12.5". */
export const percentString = (basisPoints: number): string => exact(basisPoints).div(100).toString();

/** `numerator ÷ denominator` as a decimal string with `places` decimals, half-up (e.g. GB-days). */
export const ratioString = (numerator: bigint, denominator: bigint, places: number): string =>
  exact(numerator).div(exact(denominator)).toFixed(places);

/** `numerator ÷ denominator`, half-up to a whole number (e.g. average bytes over a day). */
export const roundedRatio = (numerator: bigint, denominator: bigint): bigint => whole(exact(numerator).div(exact(denominator)));

/** Whether `amount` has reached `percent`% of `limit` — compared without dividing. */
export const reachesPercent = (amountPaise: bigint, limitPaise: bigint, percent: number): boolean =>
  amountPaise * 100n >= limitPaise * BigInt(percent);

/** The whole percentage of `limit` that `amount` is, rounded down (84.9% → 84). */
export const percentOf = (amountPaise: bigint, limitPaise: bigint): number =>
  limitPaise <= 0n ? 0 : Number((amountPaise * 100n) / limitPaise);

// Indian digit grouping: the last three digits, then pairs — 1,00,000.
const groupIndian = (digits: string): string =>
  digits.length <= 3 ? digits : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ",")},${digits.slice(-3)}`;

/**
 * Paise as rupees for people to read: "₹43.27", "₹1,00,000.00". `wholeRupees` drops ".00" from
 * round amounts, for limits ("your ₹100 limit"). Display only; the wire carries paise strings.
 */
export const formatRupees = (paise: bigint, options: { wholeRupees?: boolean } = {}): string => {
  const sign = paise < 0n ? "−" : "";
  const abs = paise < 0n ? -paise : paise;
  const rupees = groupIndian((abs / 100n).toString());
  const rest = abs % 100n;
  if (options.wholeRupees && rest === 0n) return `${sign}₹${rupees}`;
  return `${sign}₹${rupees}.${rest.toString().padStart(2, "0")}`;
};
