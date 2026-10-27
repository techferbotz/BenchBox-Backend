import { notificationRepository } from "../../notifications/repository/notification.repository";
import { dueAlerts } from "../billing.rules";
import { billingRepository } from "../repository/billing.repository";
import { billingService } from "./billing.service";

// Usage alerts (docs/BACKEND_PLAN.md §7.4): when this month so far reaches 80% and 100% of the
// monthly limit, and when the projection goes above it. Reaching the limit only notifies: uploads
// keep working. The notifications go out through the outbox.

const ACCOUNT_BATCH = 200;

export class AlertsService {
  /**
   * Job (billing.alerts, hourly): check every account with a monthly limit and make the alerts it
   * is due. Each alert's key is unique per month and limit, so checking again sends nothing twice.
   */
  async run(now: Date): Promise<string> {
    let accounts = 0;
    let made = 0;
    for (let after: string | null = null; ; ) {
      const batch = await billingRepository.accountsWithLimit(after, ACCOUNT_BATCH);
      for (const { userId, limitPaise } of batch) {
        const bill = await billingService.month(userId, now);
        const alerts = dueAlerts({
          userId,
          month: bill.month,
          limitPaise,
          toDatePaise: bill.toDate.totalPaise,
          projectedPaise: bill.projected.totalPaise,
        });
        if (alerts.length > 0) {
          made += (await notificationRepository.inTransaction(userId, now, (notifications) => notifications.create(alerts))).length;
        }
        accounts += 1;
      }
      if (batch.length < ACCOUNT_BATCH) break;
      after = batch[batch.length - 1]!.userId;
    }
    return `checked ${accounts} account(s) with a limit: ${made} new alert(s)`;
  }
}

export const alertsService = new AlertsService();
