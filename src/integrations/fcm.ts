import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { config, FcmConfig } from "../config/env";
import { DeliveryOutcome, PushResult, PushSender } from "./senders";

// Firebase Cloud Messaging, for billing alerts on the phone (deviation D7). The ONLY importer of
// firebase-admin, and only of its app and messaging entry points (the SDK's Firestore and Storage
// are never loaded). Not configured (no FCM_* variables) → `pushSender` is null and the
// notifications service skips push, logging why.

/** Android shows these under the app's "Billing" notification channel. */
export const BILLING_CHANNEL_ID = "billing";

const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered", // uninstalled, or the token rotated
  "messaging/invalid-registration-token",
  "messaging/mismatched-credential", // a token from another Firebase project
  "messaging/invalid-recipient",
]);

const MAY_PASS = new Set([
  "messaging/server-unavailable",
  "messaging/internal-error",
  "messaging/unknown-error",
  "messaging/message-rate-exceeded",
  "messaging/device-message-rate-exceeded",
  // Our credential is wrong: retried, so the alert still goes out once it's fixed.
  "messaging/authentication-error",
  "app/invalid-credential",
]);

/** What an FCM error code means for one token. Pure (check:metering pins it). */
export const classifyFcmError = (code: string | undefined): DeliveryOutcome => {
  if (code && DEAD_TOKEN.has(code)) return "invalid-token";
  if (!code || MAY_PASS.has(code)) return "retry";
  return "failed";
};

export const createFcmSender = (cfg: FcmConfig): PushSender => {
  const app = initializeApp(
    { credential: cert({ projectId: cfg.projectId, clientEmail: cfg.clientEmail, privateKey: cfg.privateKey }), projectId: cfg.projectId },
    "benchbox-push"
  );
  const messaging = getMessaging(app);

  return {
    async send(tokens, message): Promise<PushResult[]> {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: "high", notification: { channelId: BILLING_CHANNEL_ID } },
      });
      return response.responses.map((result, i) => ({
        token: tokens[i]!,
        outcome: result.success ? "sent" : classifyFcmError(result.error?.code),
        error: result.success ? null : `${result.error?.code ?? "unknown"}: ${result.error?.message ?? ""}`.slice(0, 300),
      }));
    },
  };
};

export const pushSender: PushSender | null = config.fcm ? createFcmSender(config.fcm) : null;
