import { addMonths, fromDateColumn, istDate, monthEnd, monthOf, monthStart } from "../../../common/time";
import { PriceBookRow, requirePriceBook } from "../../metering/metering.rules";
import { meteringRepository } from "../../metering/repository/metering.repository";
import { meteringService } from "../../metering/service/metering.service";
import { MIN_BILLABLE_MICRO_PAISE } from "../billing.policy";
import { billTotals, statementStatusFor } from "../billing.rules";
import { BillingTx, billingRepository } from "../repository/billing.repository";
import { statementRepository } from "../repository/statement.repository";

// Monthly statements (docs/BACKEND_PLAN.md §7.2): on the 1st, each account's closed days of the
// month just ended become one statement — the exact charges rounded once, GST on that, plus any
// earlier total that was below the minimum charge. No charging here: P5's settlement collects OPEN
// statements.

const ACCOUNT_BATCH = 200;

export class StatementsService {
  /**
   * Job (billing.closeCycle, monthly on the 1st): bill every month that has ended and isn't billed
   * yet — normally just last month; after an outage, every month missed, oldest first. Idempotent:
   * a month is billed once per account (unique per account and month, made under its row lock).
   */
  async closeCycle(now: Date): Promise<string> {
    const current = monthOf(istDate(now));
    // Every account's days through yesterday first (normally done at 00:10 already).
    await meteringService.closeDays(now);
    const books = await meteringRepository.priceBooks();
    let accounts = 0;
    let open = 0;
    let carried = 0;
    for (let after: string | null = null; ; ) {
      const ids = await statementRepository.accountsToBill(current, after, ACCOUNT_BATCH, MIN_BILLABLE_MICRO_PAISE);
      for (const id of ids) {
        const made = await billingRepository.inAccountLock(id, now, (billing) => this.closeAccount(billing, current, books));
        open += made.open;
        carried += made.carried;
        accounts += 1;
      }
      if (ids.length < ACCOUNT_BATCH) break;
      after = ids[ids.length - 1]!;
    }
    return `made ${open + carried} statement(s) for ${accounts} account(s) before ${current}: ${open} open, ${carried} carried`;
  }

  /**
   * One account's statements for the months before `current` that aren't billed yet, oldest
   * first, in the transaction holding its row lock. A month whose charges come to less than half a
   * paisa gets none. A total below the minimum charge is CARRIED: the account's next statement
   * takes it in (`carriedInPaise`) and records where it went.
   */
  async closeAccount(billing: BillingTx, current: string, books: readonly PriceBookRow[]): Promise<{ open: number; carried: number }> {
    const made = { open: 0, carried: 0 };
    await meteringService.closeAccount(billing.meter, monthEnd(addMonths(current, -1)), books);
    const latest = await billing.statements.latest();
    const after = latest ? monthOf(fromDateColumn(latest.periodStart)) : null;
    for (const month of await billing.statements.monthsToBill(after, current, MIN_BILLABLE_MICRO_PAISE)) {
      const days = await billing.meter.daysBetween(monthStart(month), monthEnd(month));
      const book = requirePriceBook(books, month);
      let byteMs = 0n;
      let billableByteMs = 0n;
      let charge = 0n;
      for (const day of days) {
        byteMs += day.byteMs;
        billableByteMs += day.billableByteMs;
        charge += day.chargeMicroPaise;
      }
      const carry = await billing.statements.pendingCarry();
      const totals = billTotals(charge, book.gstBasisPoints, carry?.totalPaise ?? 0n);
      const status = statementStatusFor(totals.totalPaise, book.minimumChargePaise);
      const statement = await billing.statements.create({ month, byteMs, billableByteMs, book, totals, status });
      if (carry) await billing.statements.markCarriedInto(carry.id, statement.id);
      if (status === "CARRIED") {
        made.carried += 1;
        continue;
      }
      made.open += 1;
      if (!billing.account.deletedAt) {
        await billing.notifications.create([
          {
            dedupeKey: `statement:${statement.id}`,
            content: { type: "STATEMENT_READY", payload: { month, statementId: statement.id, totalPaise: totals.totalPaise.toString() } },
          },
        ]);
      }
    }
    return made;
  }
}

export const statementsService = new StatementsService();
