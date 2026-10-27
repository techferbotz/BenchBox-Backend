import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { config, SesConfig } from "../config/env";
import { DeliveryOutcome, EmailSender } from "./senders";

// Amazon SES, for billing alerts by email (deviation D7). The ONLY importer of the SES SDK.
// Not configured (no SES_* variables) → `emailSender` is null and the notifications service skips
// email, logging why. Addresses never go to the log.

// Errors that retrying won't fix: the message or the account, not the moment.
const PERMANENT = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "BadRequestException",
  "NotFoundException",
]);

/** What an SES error means. Throttling, outages and network failures may pass. Pure (check:metering pins it). */
export const classifySesError = (name: string | undefined): Exclude<DeliveryOutcome, "invalid-token"> =>
  name && PERMANENT.has(name) ? "failed" : "retry";

/** SES names the failing addresses in some errors ("…failed the check: a@b.c"): keep them out of logs and rows. */
export const redactAddresses = (text: string): string => text.replace(/[^\s<>@:,;"']+@[^\s<>@:,;"']+/g, "<address>");

export const createSesSender = (cfg: SesConfig): EmailSender => {
  const client = new SESv2Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    maxAttempts: 3,
    // An email outage must fail a delivery attempt, not hang the outbox drain.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 },
  });

  return {
    async send(message) {
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: cfg.from,
            Destination: { ToAddresses: [message.to] },
            Content: {
              Simple: {
                Subject: { Data: message.subject, Charset: "UTF-8" },
                Body: { Text: { Data: message.text, Charset: "UTF-8" }, Html: { Data: message.html, Charset: "UTF-8" } },
              },
            },
          })
        );
        return { outcome: "sent", error: null };
      } catch (err) {
        const e = err as { name?: string; message?: string };
        const reason = redactAddresses(`${e.name ?? "Error"}: ${e.message ?? String(err)}`);
        return { outcome: classifySesError(e.name), error: reason.slice(0, 300) };
      }
    },
  };
};

export const emailSender: EmailSender | null = config.ses ? createSesSender(config.ses) : null;
