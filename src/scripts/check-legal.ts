// Fixture checks for the legal pages (HOA protocol 12, in protocol 04's check:* style — no test
// framework, no database, no network):
//
//   npm run check:legal
//
// Pins the facts each page must state (the store listings depend on them), that every number a
// page quotes comes from a constant rather than retyped prose, and that GET /config → links point
// at the pages the router actually serves. Exits 1 on the first failed assertion.

// remoteConfig.defaults imports config/env.ts, which fails fast on missing REQUIRED vars. Set
// placeholders BEFORE the imports below load it (tsc keeps statement order in CommonJS output).
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://brimbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import {
  DELETION_BACKUP_RETENTION_DAYS,
  DELETION_BILLING_RETENTION_YEARS,
  DELETION_LOG_RETENTION_DAYS,
  DELETION_REQUEST_SLA_DAYS,
  DELETION_STORAGE_PURGE_DAYS,
  LEGAL_APP_NAME,
  LEGAL_COMPANY,
  LEGAL_CONTACT_EMAIL,
  LEGAL_PATHS,
  LIMIT_ALERT_PERCENTS,
  MINIMUM_AGE,
  PAST_DUE_TO_SUSPENDED_DAYS,
  PAYMENT_DUE_DAYS,
  PRICE_CHANGE_NOTICE_DAYS,
  SUSPENDED_TO_DELETION_DAYS,
  TRASH_RETENTION_DAYS,
  renderDeleteAccount,
  renderPrivacyPolicy,
  renderTermsOfService,
} from "../modules/legal/legal.view";
import { DEFAULT_REMOTE_CONFIG } from "../modules/remoteConfig/remoteConfig.defaults";

let passed = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
};

// Prose wraps across source lines, so match against collapsed whitespace rather than pinning
// assertions to the template literal's line breaks.
const collapse = (html: string): string => html.replace(/\s+/g, " ");
const includesAll = (text: string, needles: readonly string[], what: string): void => {
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${what} must contain: ${needle}`);
  }
};

const privacy = collapse(renderPrivacyPolicy());
const terms = collapse(renderTermsOfService());
const deletion = collapse(renderDeleteAccount());

// ---------------------------------------------------------------- every page
check("pages: full, self-contained HTML documents naming the app", () => {
  for (const page of [privacy, terms, deletion]) {
    assert.ok(page.startsWith("<!DOCTYPE html>"));
    assert.ok(page.includes(LEGAL_APP_NAME));
    assert.ok(page.includes(`mailto:${LEGAL_CONTACT_EMAIL}`), "must expose the contact address");
    // Protocol 12: no external scripts or fonts — the pages must render with nothing else up.
    assert.ok(!/<script|<link /i.test(page), "no external scripts or stylesheets");
  }
});

// ---------------------------------------------------------------- privacy policy
check("privacy: has every section protocol 12 requires", () => {
  includesAll(
    privacy,
    [
      "Information We Collect",
      "How We Use Your Information",
      "How We Share Information",
      "Data Retention",
      "Security",
      "Your Rights",
      "Children",
      "International Transfers",
      "Changes to This Policy",
      "Contact Us",
    ],
    "privacy"
  );
});

check("privacy: names every processor the backend uses", () => {
  includesAll(
    privacy,
    ["Cloudflare", "Amazon Web Services", "Amazon SES", "Google", "Firebase Cloud Messaging", "Razorpay", "RevenueCat"],
    "privacy"
  );
});

check("privacy: honest about encryption, payment details, and share links", () => {
  includesAll(
    privacy,
    ["not end-to-end encrypted", "UPI PIN", "Anyone who has one of your share links"],
    "privacy"
  );
});

check("privacy: quotes the retention constants", () => {
  includesAll(
    privacy,
    [
      `${TRASH_RETENTION_DAYS} days`,
      `${DELETION_BILLING_RETENTION_YEARS} years`,
      `${DELETION_LOG_RETENTION_DAYS} days`,
      `${DELETION_BACKUP_RETENTION_DAYS} days`,
      `aged ${MINIMUM_AGE} or older`,
    ],
    "privacy"
  );
});

// ---------------------------------------------------------------- terms
check("terms: has every section protocol 12 requires", () => {
  includesAll(
    terms,
    [
      "Eligibility",
      "The Service",
      "Your Account",
      "Storage Charges and Billing",
      "Auto-Pay Mandate",
      "Google Play Credits",
      "Unpaid Bills",
      "Refunds",
      "Your Files",
      "Sharing",
      "Acceptable Use",
      "Intellectual Property",
      "Third-Party Services",
      "Termination",
      "Disclaimers",
      "Limitation of Liability",
      "Indemnification",
      "Governing Law",
      "Changes to These Terms",
      "Contact Us",
    ],
    "terms"
  );
});

check("terms: quotes the billing policy constants", () => {
  const [firstAlert, secondAlert] = LIMIT_ALERT_PERCENTS;
  includesAll(
    terms,
    [
      `at least ${MINIMUM_AGE} years old`,
      `${firstAlert}% and ${secondAlert}% of your limit`,
      `due within ${PAYMENT_DUE_DAYS} days`,
      `${PAST_DUE_TO_SUSPENDED_DAYS} days later`,
      `${SUSPENDED_TO_DELETION_DAYS} days after suspension`,
      `at least ${PRICE_CHANGE_NOTICE_DAYS} days`,
    ],
    "terms"
  );
});

check("terms: states the billing facts the app shows", () => {
  includesAll(
    terms,
    ["monthly limit", "Reaching the limit does not stop the Service", "Files in Trash count", "1,000,000,000 bytes", "read-only"],
    "terms"
  );
});

// ---------------------------------------------------------------- delete-account (Google Play)
// Each check maps to one of Play's stated requirements for the "Delete account URL" on a listing.
check("delete-account: names the app and the developer on the listing", () => {
  assert.ok(deletion.includes(`Delete your ${LEGAL_APP_NAME} account`));
  assert.ok(deletion.includes(LEGAL_COMPANY));
});

check("delete-account: numbered in-app steps, plus an email route with a deadline", () => {
  includesAll(
    deletion,
    ['<ol class="steps">', "Settings", "Delete account", "Delete my account", `${DELETION_REQUEST_SLA_DAYS} days`],
    "delete-account"
  );
});

check("delete-account: lists what is deleted", () => {
  includesAll(
    deletion,
    ["What is deleted", "account details", "All your files and folders", "share links", "signed-in devices"],
    "delete-account"
  );
});

check("delete-account: states what is kept and for how long", () => {
  includesAll(
    deletion,
    [
      "What is kept, and for how long",
      `${DELETION_BILLING_RETENTION_YEARS} years`,
      `${DELETION_LOG_RETENTION_DAYS} days`,
      `${DELETION_BACKUP_RETENTION_DAYS} days`,
      `within <strong>${DELETION_STORAGE_PURGE_DAYS} days</strong>`,
    ],
    "delete-account"
  );
  // The storage log bills are computed from outlives the account (anonymised): it must be listed
  // as kept, never as deleted.
  const [deleted, kept] = deletion.split("What is kept, and for how long");
  assert.ok(kept?.includes("how much storage your account used over time"), "the usage record is listed as kept");
  assert.ok(!deleted?.toLowerCase().includes("usage history"), "and not as deleted");
});

check("delete-account: covers the final bill, the mandate, and credits", () => {
  includesAll(
    deletion,
    ["final statement", "cancel your auto-pay mandate", "Google Play credits are lost"],
    "delete-account"
  );
});

// ---------------------------------------------------------------- links in GET /config
check("links: /config points at the routes this backend serves, on the configured origin", () => {
  const origin = process.env.APP_PUBLIC_URL;
  assert.equal(DEFAULT_REMOTE_CONFIG.links.privacyPolicy, `${origin}${LEGAL_PATHS.privacy}`);
  assert.equal(DEFAULT_REMOTE_CONFIG.links.terms, `${origin}${LEGAL_PATHS.terms}`);
  assert.equal(DEFAULT_REMOTE_CONFIG.links.deleteAccount, `${origin}${LEGAL_PATHS.deleteAccount}`);
  assert.equal(DEFAULT_REMOTE_CONFIG.links.supportEmail, LEGAL_CONTACT_EMAIL);
});

console.log(`\ncheck:legal — ${passed} checks passed`);
