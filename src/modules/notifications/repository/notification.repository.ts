import { randomUUID } from "node:crypto";
import { DeliveryState, Notification, Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { notificationJob } from "../../outbox/outbox.jobs";
import { OutboxTx } from "../../outbox/repository/outbox.repository";
import { CHANNELS, NotificationContent } from "../notifications.messages";

// All Notification database access. A notification is made inside the transaction whose outcome it
// announces, with the outbox job that sends it, so it can be neither lost nor sent for something
// that rolled back. `dedupeKey` is unique: making one twice makes it once.

export interface NewNotification {
  dedupeKey: string;
  content: NotificationContent;
  /** Record it without sending it: a bigger alert went out instead. Says which. */
  supersededBy?: string;
}

/** Notifications inside an open transaction. */
export class NotificationTx {
  private readonly outbox: OutboxTx;

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
    private readonly now: Date
  ) {
    this.outbox = new OutboxTx(tx);
  }

  /**
   * Make each notification whose key is new, and queue the sending of those with a channel to send.
   * A key already used is skipped (ON CONFLICT DO NOTHING, so the transaction carries on). Returns
   * the keys made now.
   */
  async create(items: readonly NewNotification[]): Promise<string[]> {
    const made: string[] = [];
    for (const item of items) {
      const channels = CHANNELS[item.content.type];
      const state = (used: boolean): DeliveryState =>
        !used ? DeliveryState.NONE : item.supersededBy ? DeliveryState.SKIPPED : DeliveryState.PENDING;
      const detail = (used: boolean): string | null => (used && item.supersededBy ? `superseded by ${item.supersededBy}` : null);
      const id = randomUUID();
      const { count } = await this.tx.notification.createMany({
        data: [
          {
            id,
            userId: this.userId,
            dedupeKey: item.dedupeKey,
            type: item.content.type,
            payload: item.content.payload as Prisma.InputJsonObject,
            push: state(channels.push),
            email: state(channels.email),
            pushDetail: detail(channels.push),
            emailDetail: detail(channels.email),
            createdAt: this.now,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) continue;
      made.push(item.dedupeKey);
      if (!item.supersededBy) await this.outbox.enqueue([notificationJob(id, this.now)]);
    }
    return made;
  }
}

export class NotificationRepository {
  /** Run `fn` in a transaction, to make notifications that don't belong to a bigger one. */
  async inTransaction<T>(userId: string, now: Date, fn: (notifications: NotificationTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => fn(new NotificationTx(tx, userId, now)));
  }

  async find(id: string): Promise<Notification | null> {
    return prisma.notification.findUnique({ where: { id } });
  }

  /** Record how a channel went. */
  async record(
    id: string,
    channel: "push" | "email",
    outcome: { state: DeliveryState; detail: string | null }
  ): Promise<void> {
    const data = channel === "push" ? { push: outcome.state, pushDetail: outcome.detail } : { email: outcome.state, emailDetail: outcome.detail };
    await prisma.notification.updateMany({ where: { id }, data });
  }
}

export const notificationRepository = new NotificationRepository();
