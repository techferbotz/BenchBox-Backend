// What the notifications service needs from a push provider and an email provider (deviation D7).
// The implementations are fcm.ts and ses.ts, each the sole importer of its SDK; the service takes
// them as constructor dependencies (null when not configured), which is how check:billing-db runs
// it against fakes.

/**
 * How one delivery went:
 *   - sent: accepted by the provider;
 *   - invalid-token: the device token is dead (app uninstalled, token rotated) — stop using it;
 *   - retry: may pass (rate limits, outages, a credential being fixed) — try again later;
 *   - failed: won't pass by retrying (a rejected address, a malformed message).
 */
export type DeliveryOutcome = "sent" | "invalid-token" | "retry" | "failed";

export interface PushMessage {
  title: string;
  body: string;
  /** What the app routes on. FCM data values are strings. */
  data: Record<string, string>;
}

export interface PushResult {
  token: string;
  outcome: DeliveryOutcome;
  /** The provider's reason, for the log and the notification row; never the token. */
  error: string | null;
}

export interface PushSender {
  /** One message to each of a user's devices. */
  send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ outcome: Exclude<DeliveryOutcome, "invalid-token">; error: string | null }>;
}
