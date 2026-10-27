import { formatRupees } from "../../common/money";
import { monthName } from "../../common/time";
import { PushMessage } from "../../integrations/senders";

// The billing alerts (docs/BACKEND_PLAN.md §7.4) and their words, in the UI brief's voice
// (docs/UI_DESIGN_PROMPT.md). A notification stores its facts — amounts as paise strings — and is
// worded when it is sent. Pure: check:metering pins the copy.

export type NotificationType = "LIMIT_ALERT" | "PROJECTED_OVER_LIMIT" | "STATEMENT_READY";

export type NotificationContent =
  /** This month so far has reached `percent`% of the monthly limit. */
  | { type: "LIMIT_ALERT"; payload: { month: string; percent: number; limitPaise: string; toDatePaise: string } }
  /** The month's projected total is above the monthly limit. */
  | { type: "PROJECTED_OVER_LIMIT"; payload: { month: string; limitPaise: string; projectedPaise: string } }
  /** A statement was closed with an amount to collect. */
  | { type: "STATEMENT_READY"; payload: { month: string; statementId: string; totalPaise: string } };

/** The channels each kind goes out on (§7.4): the projection is a push-only heads-up. */
export const CHANNELS: Record<NotificationType, { push: boolean; email: boolean }> = {
  LIMIT_ALERT: { push: true, email: true },
  PROJECTED_OVER_LIMIT: { push: true, email: false },
  STATEMENT_READY: { push: true, email: true },
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PAISE = /^\d{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stored notification, checked. One that doesn't parse is a bug: it fails, visibly, in the outbox. */
export const parseNotification = (type: string, payload: unknown): NotificationContent => {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const text = (key: string, pattern: RegExp): string => {
    const value = p[key];
    if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Unreadable ${type} notification: ${key}`);
    return value;
  };
  switch (type) {
    case "LIMIT_ALERT": {
      const percent = p.percent;
      if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1) throw new Error("Unreadable LIMIT_ALERT notification: percent");
      return { type, payload: { month: text("month", MONTH), percent, limitPaise: text("limitPaise", PAISE), toDatePaise: text("toDatePaise", PAISE) } };
    }
    case "PROJECTED_OVER_LIMIT":
      return { type, payload: { month: text("month", MONTH), limitPaise: text("limitPaise", PAISE), projectedPaise: text("projectedPaise", PAISE) } };
    case "STATEMENT_READY":
      return { type, payload: { month: text("month", MONTH), statementId: text("statementId", UUID), totalPaise: text("totalPaise", PAISE) } };
    default:
      throw new Error(`Unknown notification type ${type}`);
  }
};

export interface RenderedNotification {
  push: PushMessage;
  email: { subject: string; text: string; html: string };
}

const rupees = (paise: string): string => formatRupees(BigInt(paise));
const limitRupees = (paise: string): string => formatRupees(BigInt(paise), { wholeRupees: true });

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The words of a notification: a push (title, body, and `data` for the app to route on — `type`
 * and the ids the screen needs) and an email. Push `data.type` is the lower-case kind.
 */
export const renderNotification = (id: string, content: NotificationContent): RenderedNotification => {
  const { month } = content.payload;
  const monthOnly = monthName(month).split(" ")[0]!;
  let title: string;
  let body: string;
  let opens: string;
  const data: Record<string, string> = { type: content.type.toLowerCase(), notificationId: id, month };

  switch (content.type) {
    case "LIMIT_ALERT": {
      const { percent, limitPaise, toDatePaise } = content.payload;
      const passed = percent >= 100;
      title = passed
        ? `You've passed your ${limitRupees(limitPaise)} limit`
        : `You've used ${percent}% of your ${limitRupees(limitPaise)} limit`;
      body = `${rupees(toDatePaise)} so far in ${monthOnly}.${passed ? " Uploads keep working." : ""}`;
      opens = "your usage";
      data.percent = String(percent);
      break;
    }
    case "PROJECTED_OVER_LIMIT": {
      const { limitPaise, projectedPaise } = content.payload;
      title = "Your estimated bill is above your limit";
      body = `${monthOnly}'s bill is on course for ${rupees(projectedPaise)}, above your ${limitRupees(limitPaise)} limit.`;
      opens = "your usage";
      break;
    }
    case "STATEMENT_READY": {
      const { statementId, totalPaise } = content.payload;
      title = `Your ${monthOnly} bill is ${rupees(totalPaise)}`;
      body = "Open BenchBox to see the statement.";
      opens = "the statement";
      data.statementId = statementId;
      break;
    }
  }

  const footer = "Billing emails are part of the BenchBox service, so they can't be turned off.";
  const text = `${title}\n\n${body}\n\nOpen the BenchBox app to see ${opens}.\n\n—\n${footer}\n`;
  const html =
    `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#1b1f24;line-height:1.5">` +
    `<p style="font-size:18px;font-weight:600">${escapeHtml(title)}</p>` +
    `<p>${escapeHtml(body)}</p>` +
    `<p>Open the BenchBox app to see ${escapeHtml(opens)}.</p>` +
    `<p style="color:#656d76;font-size:13px">${escapeHtml(footer)}</p>` +
    `</body></html>`;
  return { push: { title, body, data }, email: { subject: title, text, html } };
};
