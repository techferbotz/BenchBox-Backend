import { DeliveryState } from "@prisma/client";
import { pushSender } from "../../../integrations/fcm";
import { EmailSender, PushMessage, PushSender } from "../../../integrations/senders";
import { emailSender } from "../../../integrations/ses";
import { userRepository } from "../../account/repository/user.repository";
import { sessionRepository } from "../../auth/repository/session.repository";
import { NotificationContent, parseNotification, renderNotification, RenderedNotification } from "../notifications.messages";
import { NOTIFICATION_RETRY_HOURS } from "../notifications.policy";
import { notificationRepository } from "../repository/notification.repository";

// Sending billing alerts (deviation D7): push through FCM to every signed-in device that registered
// a token, email through SES to the account's address. The outbox runs this after the transaction
// that made the notification commits. A channel that isn't configured, or has nowhere to send, is
// SKIPPED and logged — never a crash.

export interface NotificationsServiceDeps {
  now: () => Date;
  /** Null when FCM isn't configured. */
  push: PushSender | null;
  /** Null when SES isn't configured. */
  email: EmailSender | null;
}

interface ChannelResult {
  state: DeliveryState;
  detail: string | null;
}

const settled = (state: DeliveryState, detail: string | null = null): ChannelResult => ({ state, detail });

export class NotificationsService {
  constructor(private readonly deps: NotificationsServiceDeps) {}

  /**
   * Send a notification's PENDING channels. A channel that may still go through later (an outage,
   * a rate limit) stays PENDING and this throws, so the outbox retries it with backoff; after
   * NOTIFICATION_RETRY_HOURS it is given up as FAILED. A channel never goes out twice once SENT.
   */
  async deliver(notificationId: string): Promise<void> {
    const row = await notificationRepository.find(notificationId);
    if (!row) return; // the account was deleted, its notifications with it
    const now = this.deps.now();
    const content = parseNotification(row.type, row.payload);
    const message = renderNotification(row.id, content);
    const expired = now.getTime() - row.createdAt.getTime() >= NOTIFICATION_RETRY_HOURS * 60 * 60 * 1000;
    const retrying: string[] = [];

    const channels: ["push" | "email", DeliveryState, () => Promise<ChannelResult>][] = [
      ["push", row.push, () => this.sendPush(row.userId, message.push, now)],
      ["email", row.email, () => this.sendEmail(row.userId, message)],
    ];
    for (const [channel, state, send] of channels) {
      if (state !== DeliveryState.PENDING) continue;
      let result = await send();
      if (result.state === DeliveryState.PENDING) {
        if (expired) result = settled(DeliveryState.FAILED, `gave up after ${NOTIFICATION_RETRY_HOURS} h: ${result.detail}`);
        else retrying.push(`${channel}: ${result.detail}`);
      }
      if (result.state === DeliveryState.SKIPPED) this.logSkip(channel, content, row.id, result.detail);
      await notificationRepository.record(row.id, channel, result);
    }
    if (retrying.length > 0) throw new Error(`notification ${row.id} will be retried (${retrying.join("; ")})`);
  }

  private logSkip(channel: string, content: NotificationContent, id: string, detail: string | null): void {
    console.warn(`[notifications] ${channel} skipped for ${content.type} ${id}: ${detail}`);
  }

  private async sendPush(userId: string, message: PushMessage, now: Date): Promise<ChannelResult> {
    if (!this.deps.push) return settled(DeliveryState.SKIPPED, "push isn't configured (FCM_* unset)");
    const tokens = await sessionRepository.pushTokensFor(userId, now);
    if (tokens.length === 0) return settled(DeliveryState.SKIPPED, "no signed-in device has notifications on");
    let results;
    try {
      results = await this.deps.push.send(tokens, message);
    } catch (err) {
      return settled(DeliveryState.PENDING, `FCM: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
    const dead = results.filter((result) => result.outcome === "invalid-token").map((result) => result.token);
    await sessionRepository.clearPushTokens(dead);
    if (results.some((result) => result.outcome === "sent")) return settled(DeliveryState.SENT);
    const retry = results.find((result) => result.outcome === "retry");
    if (retry) return settled(DeliveryState.PENDING, retry.error);
    if (dead.length === results.length) return settled(DeliveryState.SKIPPED, "every device's token was stale");
    return settled(DeliveryState.FAILED, results.find((result) => result.outcome === "failed")?.error ?? null);
  }

  private async sendEmail(userId: string, message: RenderedNotification): Promise<ChannelResult> {
    if (!this.deps.email) return settled(DeliveryState.SKIPPED, "email isn't configured (SES_* unset)");
    const user = await userRepository.findActiveById(userId);
    if (!user?.email) return settled(DeliveryState.SKIPPED, "the account has no email address");
    const result = await this.deps.email.send({ to: user.email, ...message.email });
    if (result.outcome === "sent") return settled(DeliveryState.SENT);
    return settled(result.outcome === "retry" ? DeliveryState.PENDING : DeliveryState.FAILED, result.error);
  }
}

export const notificationsService = new NotificationsService({ now: () => new Date(), push: pushSender, email: emailSender });
