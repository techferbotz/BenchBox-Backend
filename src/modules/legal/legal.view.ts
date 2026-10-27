/**
 * Legal page content: privacy policy, terms of service and account deletion (HOA protocol 12).
 *
 * The prose describes BenchBox v1 as designed in docs/BACKEND_PLAN.md: Google sign-in, files in
 * Cloudflare R2, servers/database/email on AWS, a postpaid monthly bill collected through a
 * Razorpay auto-pay mandate with a user-chosen limit, Google Play credits, Firebase Cloud
 * Messaging for push, and share links. Protocol 12's rule is "only claim what the code does": the
 * features land phase by phase, so any phase that ships behaviour different from what a page says
 * changes the page IN THE SAME COMMIT, and the pages must match the shipped code before they go on
 * a store listing. These are starting templates — have them reviewed by a legal professional and
 * fill every TODO before publishing.
 */

import {
  LIMIT_ALERT_PERCENTS,
  PAST_DUE_TO_SUSPENDED_DAYS,
  PAYMENT_DUE_DAYS,
  SUSPENDED_TO_DELETION_DAYS,
} from "../billing/billing.policy";
import { DELETION_STORAGE_PURGE_DAYS } from "../files/files.policy";
import { PRICE_CHANGE_NOTICE_DAYS } from "../metering/metering.policy";
import { TRASH_RETENTION_DAYS } from "../nodes/nodes.policy";

// ── Shared across all documents (edit in one place) ──
export const LEGAL_APP_NAME = "BenchBox";
// TODO(legal): confirm the exact legal entity that operates BenchBox.
export const LEGAL_COMPANY = "Ferbotz";
// TODO(legal): set the real support/privacy inbox (a role inbox is better than a personal one).
// The app gets this address from GET /config → links.supportEmail; it is defined only here.
export const LEGAL_CONTACT_EMAIL = "support@ferbotz.com";
// TODO(legal): India's IT Rules 2021 expect a named Grievance Officer for services that host user
// content (BenchBox share links). Add the officer's name and contact to the privacy page and terms
// once appointed.

// Route paths, shared with the router and with GET /config → links so neither can drift.
export const LEGAL_PATHS = {
  privacy: "/privacy",
  terms: "/terms",
  deleteAccount: "/delete-account",
} as const;

// ── Per-document ──
// Bump on each material change.
export const PRIVACY_EFFECTIVE_DATE = "October 22, 2026";
export const TERMS_EFFECTIVE_DATE = "October 27, 2026";
export const DELETE_ACCOUNT_EFFECTIVE_DATE = "October 22, 2026";
// TODO(legal): set the governing jurisdiction (e.g. "India", with the courts of a named city).
export const TERMS_GOVERNING_LAW = "[your jurisdiction]";
// Accounts are for adults: setting up an auto-pay mandate needs one, and India's DPDP Act treats
// anyone under 18 as a child whose data needs verifiable parental consent.
export const MINIMUM_AGE = 18;

// ── Public promises. Each lives with the module that enforces it and is imported here, so the page
// and the behaviour can't drift; the ones defined below have no enforcing module yet — MOVE each
// there when it lands. Change the reality and the constant together. ──
/** Trash is permanently deleted after this many days — enforced by the trash.autoPurge job. */
export { TRASH_RETENTION_DAYS };
/**
 * After an account is deleted, its files are removed from object storage within this many days —
 * enforced by the outbox's sweep of the account's prefix (files.policy.ts).
 */
export { DELETION_STORAGE_PURGE_DAYS };
/**
 * Billing windows (billing.policy.ts; suggested defaults, see docs/BACKEND_PLAN.md §13): usage
 * alerts at these percentages of the monthly limit (billing.alerts), and from P5 the payment due
 * window and the past-due → suspended → deleted steps.
 */
export { LIMIT_ALERT_PERCENTS, PAYMENT_DUE_DAYS, PAST_DUE_TO_SUSPENDED_DAYS, SUSPENDED_TO_DELETION_DAYS };
/** Minimum notice before a price increase takes effect — enforced by the price-book rule (metering.rules.ts). */
export { PRICE_CHANGE_NOTICE_DAYS };
/** Deadline for actioning an emailed deletion request. In-app deletion closes the account at once. */
export const DELETION_REQUEST_SLA_DAYS = 30;
/** How long deleted rows can still exist in routine encrypted database backups (nightly dumps). */
export const DELETION_BACKUP_RETENTION_DAYS = 30;
/** How long operational/server logs (IP + request metadata) are held. */
export const DELETION_LOG_RETENTION_DAYS = 90;
/** How long statements and payment records are kept. TODO(legal): confirm with a CA. */
export const DELETION_BILLING_RETENTION_YEARS = 8;

/** Shared HTML shell (head + readable document styling) wrapping a document body. */
function renderLegalPage(title: string, lastUpdated: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · ${LEGAL_APP_NAME}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.6;
      color: #1b1f24; background: #ffffff; margin: 0; padding: 40px 20px; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 1.9rem; margin: 0 0 4px; }
    h2 { font-size: 1.25rem; margin: 32px 0 8px; }
    .updated { color: #656d76; margin: 0 0 24px; }
    p, li { color: #2f363d; }
    ul, ol { padding-left: 22px; }
    li { margin: 6px 0; }
    a { color: #1f6feb; }
    strong { color: #1b1f24; }
    /* Callout: pulls the deletion steps and warnings out of the prose. */
    .callout { background: #f0f6ff; border: 1px solid #cfe2ff; border-left: 4px solid #1f6feb;
      border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    .callout > :first-child { margin-top: 0; }
    .callout > :last-child { margin-bottom: 0; }
    .warn { background: #fff7ed; border-color: #fed7aa; border-left-color: #ea580c; }
    .steps li { margin: 10px 0; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p class="updated">Last updated: ${lastUpdated}</p>
    ${body}
  </main>
</body>
</html>`;
}

export function renderPrivacyPolicy(): string {
  const app = LEGAL_APP_NAME;
  const company = LEGAL_COMPANY;
  const email = LEGAL_CONTACT_EMAIL;

  const body = `<p>This Privacy Policy explains how ${company} (&ldquo;we&rdquo;, &ldquo;us&rdquo;)
    collects, uses, and shares information when you use the ${app} mobile app, its share links, and
    related services (the &ldquo;Service&rdquo;). ${app} is cloud storage that you pay for as you
    use it. By using the Service, you agree to this policy.</p>

    <h2>1. Information We Collect</h2>
    <ul>
      <li><strong>Account information.</strong> When you sign in with Google, we receive your email
        address, name, profile photo, and a unique Google account identifier, which we use to create
        and secure your account.</li>
      <li><strong>Your files.</strong> The files you upload and the folders you create, with their
        names, sizes, types, and dates, and the small preview images (thumbnails) the app makes on
        your device so your files can be shown in lists.</li>
      <li><strong>Share links.</strong> When you share a file or folder, we keep the link&rsquo;s
        settings (what it points to, when it expires, whether you revoked it) and how many times it
        has been used.</li>
      <li><strong>Usage and billing information.</strong> How much storage your account uses over
        time and how much you download, your monthly statements, your auto-pay limit, the status of
        your auto-pay mandate and payments, and the reference numbers our payment providers give us
        for them. If we have to charge GST, we also keep the state you tell us you live in. We do
        <strong>not</strong> receive or store your full card number, your bank login, or your UPI
        PIN &mdash; our payment provider handles those.</li>
      <li><strong>Google Play purchases.</strong> If you buy credits through Google Play, we receive
        the purchase&rsquo;s transaction and product identifiers (through RevenueCat) so we can add the
        credits to your account.</li>
      <li><strong>Device and technical information.</strong> A random identifier the app creates for
        your installation, the name and platform of each device you sign in on, the app version, a
        notification token if you allow notifications, and technical data such as your IP address
        and the requests your device makes to our servers.</li>
      <li><strong>Messages.</strong> Emails you send us, and records of the service emails and
        notifications we send you.</li>
    </ul>

    <h2>2. How We Use Your Information</h2>
    <ul>
      <li>Store your files, keep them in sync across your devices, and let you share them.</li>
      <li>Measure your storage use, bill you for it, and collect payment.</li>
      <li>Send you service messages: alerts as your usage approaches and passes your auto-pay limit,
        bills, payment results, and notices before any restriction or deletion of your account.
        These are part of the Service. You can turn off push notifications in your device settings,
        but we will still send billing emails.</li>
      <li>Keep the Service secure, prevent fraud and abuse, and investigate reports about shared
        content.</li>
      <li>Provide support and respond to your requests.</li>
      <li>Comply with legal obligations, including tax and accounting rules, and enforce our
        Terms.</li>
    </ul>
    <p>We do not show ads, we do not use your files to build advertising profiles, and we do not
    sell your personal information.</p>

    <h2>3. Access to Your Files</h2>
    <p>Your files are private to your account unless you share them. They are encrypted in transit
    and stored encrypted by our storage provider, but they are <strong>not end-to-end
    encrypted</strong>: our systems can technically read them. We access the contents of your files
    only when needed to provide the Service you asked for, to investigate a report that shared
    content breaks our Terms, or when the law requires it.</p>
    <p>Anyone who has one of your share links can open what it points to until the link expires or
    you revoke it, so share links only with people you trust.</p>

    <h2>4. How We Share Information</h2>
    <p>We share information only with service providers that help us run the Service, under
    agreements that limit how they may use it:</p>
    <ul>
      <li><strong>Cloudflare</strong> &mdash; stores your files (Cloudflare R2) and runs the DNS for
        our domain.</li>
      <li><strong>Amazon Web Services</strong> &mdash; hosts our servers and database in India and
        delivers our emails (Amazon SES).</li>
      <li><strong>Google</strong> &mdash; sign-in, push notifications (Firebase Cloud Messaging),
        and Google Play billing.</li>
      <li><strong>Razorpay</strong> &mdash; sets up auto-pay mandates and processes payments.</li>
      <li><strong>RevenueCat</strong> &mdash; records Google Play purchases.</li>
    </ul>
    <p>We may also disclose information when the law requires it, to protect the rights and safety
    of our users or the public, or as part of a merger or acquisition, in which case we will tell
    you.</p>

    <h2>5. Data Retention</h2>
    <p>We keep your account information while your account is open, and your files until you delete
    them. Deleted files go to Trash, and anything in Trash is permanently deleted after
    ${TRASH_RETENTION_DAYS} days, or sooner if you empty it. If a bill stays unpaid, your account is
    restricted and eventually deleted on the schedule in our <a href="${LEGAL_PATHS.terms}">Terms of
    Service</a>, and we notify you before anything is deleted.</p>
    <p>When your account is deleted, your account details and files are deleted. We keep billing and
    payment records, including the record of how much storage your account used over time, for up
    to ${DELETION_BILLING_RETENTION_YEARS} years to meet tax and accounting obligations, operational
    logs for up to ${DELETION_LOG_RETENTION_DAYS} days, and routine
    encrypted database backups for up to ${DELETION_BACKUP_RETENTION_DAYS} days. Our
    <a href="${LEGAL_PATHS.deleteAccount}">Account Deletion</a> page lists exactly what is kept and
    for how long.</p>

    <h2>6. Security</h2>
    <p>We use encryption in transit, private storage that can only be reached through short-lived
    signed links, and access controls on our systems. No method of transmission or storage is
    completely secure, so we cannot guarantee absolute security. Keep your own copies of files you
    cannot afford to lose.</p>

    <h2>7. Your Rights and Choices</h2>
    <p>You can download your files, and delete files or your whole account, at any time. Depending
    on where you live &mdash; including under India&rsquo;s Digital Personal Data Protection Act,
    2023 &mdash; you may also have the right to access, correct, or erase your personal data, to
    withdraw consent, to nominate someone to exercise your rights, and to have a grievance
    addressed. To exercise any of these rights, or to raise a grievance, contact us at
    <a href="mailto:${email}">${email}</a>.</p>

    <h2>8. Children&rsquo;s Privacy</h2>
    <p>The Service is for people aged ${MINIMUM_AGE} or older. We do not knowingly collect personal
    data from anyone younger. If you believe a child has given us personal data, contact us and we
    will delete it.</p>

    <h2>9. International Transfers</h2>
    <p>Our servers and database are in India, but some providers process information in other
    countries: Cloudflare stores files in data centres in the Asia-Pacific region, and Google and
    RevenueCat may process data in the United States. Where the law requires it, we use appropriate
    safeguards for these transfers.</p>

    <h2>10. Changes to This Policy</h2>
    <p>We may update this policy. We will change the &ldquo;Last updated&rdquo; date above and, for
    material changes, tell you in the app or by email before they take effect.</p>

    <h2>11. Contact Us</h2>
    <p>If you have questions about this policy or your data, contact us at
    <a href="mailto:${email}">${email}</a>.</p>`;

  return renderLegalPage(`${app} Privacy Policy`, PRIVACY_EFFECTIVE_DATE, body);
}

export function renderTermsOfService(): string {
  const app = LEGAL_APP_NAME;
  const company = LEGAL_COMPANY;
  const email = LEGAL_CONTACT_EMAIL;
  const [firstAlert, secondAlert] = LIMIT_ALERT_PERCENTS;

  const body = `<p>These Terms of Service (&ldquo;Terms&rdquo;) are an agreement between you and
    ${company} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) governing your use of the ${app} mobile app, its
    share links, and related services (the &ldquo;Service&rdquo;). By using the Service you agree to
    these Terms. If you do not agree, do not use the Service.</p>

    <h2>1. Eligibility</h2>
    <p>You must be at least ${MINIMUM_AGE} years old and able to enter into a binding contract to use
    the Service.</p>

    <h2>2. The Service</h2>
    <p>${app} is cloud storage that you pay for as you use it. You can upload files, organise them in
    folders, open them on your devices, and share them with links. Every account includes a free
    storage allowance, and storage beyond it is charged as described in section 4. We may change,
    add, or remove features over time.</p>

    <h2>3. Your Account</h2>
    <p>You sign in with a Google account. Keep your devices and your Google account secure: you are
    responsible for activity under your ${app} account. You can see the devices signed in to your
    account, and sign them out, in the app. Tell us promptly if you believe someone else has used
    your account.</p>

    <h2>4. Storage Charges and Billing</h2>
    <ul>
      <li><strong>What you pay for.</strong> You pay for the storage your files use over time, beyond
        your free allowance, at the prices shown in the app. Files in Trash count until they are
        permanently deleted. Downloads are currently free.</li>
      <li><strong>How it is measured.</strong> We measure the storage your account holds
        continuously and total it for each day, in India time. A gigabyte (GB) is 1,000,000,000
        bytes &mdash; the same unit your phone uses to show file sizes.</li>
      <li><strong>Monthly bill.</strong> Usage is billed per calendar month (India time), plus GST
        where it applies. You can see your usage so far, and an estimate of the month&rsquo;s bill,
        in the app at any time. A bill below our minimum charge is not charged on its own: it is
        carried forward and added to your next bill.</li>
      <li><strong>Price changes.</strong> We will tell you at least ${PRICE_CHANGE_NOTICE_DAYS} days
        before a price increase takes effect, and it applies only to usage after that date.</li>
    </ul>

    <h2>5. Auto-Pay Mandate</h2>
    <ul>
      <li>To store more than the free allowance, you set up an auto-pay mandate (UPI AutoPay, card,
        or bank mandate) through our payment provider, Razorpay, with a <strong>monthly limit</strong>
        that you choose. You authorise us to charge each month&rsquo;s bill to it, up to that
        limit.</li>
      <li>Your bank or UPI app notifies you before each charge, as Reserve Bank of India rules
        require.</li>
      <li>We alert you when your usage for the month reaches ${firstAlert}% and ${secondAlert}% of your
        limit. Reaching the limit does not stop the Service.</li>
      <li>If a month&rsquo;s bill is more than your limit, we charge up to the limit and send you a
        payment link for the rest, due within ${PAYMENT_DUE_DAYS} days. You can raise your limit at any
        time.</li>
      <li>If a charge fails, we may try it again, and we will send you a payment link.</li>
      <li>You can change or cancel the mandate at any time, in the app or in your UPI or banking app.
        Cancelling it does not cancel amounts you already owe, and you cannot store more than the
        free allowance again until you set up a new mandate.</li>
    </ul>

    <h2>6. Google Play Credits</h2>
    <p>You can also pay in advance by buying credits through Google Play. Credits are used to pay
    your bills before your mandate is charged. Credits have no cash value, cannot be transferred, and
    do not expire while your account is open, but they are lost if your account is deleted. Refunds
    of Google Play purchases are handled under Google Play&rsquo;s policies.</p>

    <h2>7. Unpaid Bills</h2>
    <p>If a bill is still unpaid after its due date, your account becomes <strong>read-only</strong>:
    you can view, download, and share your files, but not upload new ones. If it is still unpaid
    ${PAST_DUE_TO_SUSPENDED_DAYS} days later, your account is <strong>suspended</strong>: you can
    still sign in, pay, and download your files, but your share links stop working. If it is still
    unpaid ${SUSPENDED_TO_DELETION_DAYS} days after suspension, your account and files are
    <strong>permanently deleted</strong>. We notify you before each of these steps. Paying the amount
    due at any point before deletion restores your account.</p>

    <h2>8. Refunds and Billing Errors</h2>
    <p>If you think we charged you incorrectly, contact us and we will correct genuine billing
    errors. Except for billing errors, and where the law requires otherwise, charges for storage you
    have used are not refundable.</p>

    <h2>9. Your Files</h2>
    <p>You keep all rights to the files you store. You give us a limited licence to store, copy,
    process, and transmit them only as needed to provide the Service &mdash; for example to keep
    them, show them to you, and serve them through share links you create. You are responsible for
    having the rights to the files you upload and share, including the consent of people who appear
    in them.</p>
    <p>We take care to protect your files, but you should keep copies of anything you cannot afford
    to lose.</p>

    <h2>10. Sharing</h2>
    <p>When you create a share link, anyone who has the link can view or download what it points to
    until the link expires or you revoke it. You are responsible for what you share and who you share
    it with. We may limit how often a link can be used, and we may disable links that break these
    Terms or are reported for abuse.</p>

    <h2>11. Acceptable Use</h2>
    <p>You agree not to use the Service to:</p>
    <ul>
      <li>store or share content that is illegal, including child sexual abuse material, or that
        infringes anyone&rsquo;s intellectual property, privacy, or other rights;</li>
      <li>distribute malware or anything designed to harm devices or systems;</li>
      <li>harass, threaten, defraud, or impersonate anyone;</li>
      <li>use share links as a public file host or content-delivery network, or to distribute
        content at scale;</li>
      <li>resell the Service, or get around its limits, billing, or security; or</li>
      <li>reverse engineer, scrape, overload, or disrupt the Service.</li>
    </ul>
    <p>We may remove content, disable share links, or suspend or close accounts that break these
    Terms, and we report illegal content to the authorities where the law requires it. To report
    content, use the report option on a share link or email
    <a href="mailto:${email}">${email}</a>.</p>

    <h2>12. Intellectual Property</h2>
    <p>The Service, including the app, its software, design, and branding, belongs to us or our
    licensors. These Terms give you no rights in it beyond the right to use the Service as described
    here.</p>

    <h2>13. Third-Party Services</h2>
    <p>The Service relies on third parties such as Google, Cloudflare, Amazon Web Services, Razorpay,
    and RevenueCat. Your use of their services &mdash; for example Google sign-in, Google Play, or
    your UPI or banking app &mdash; is also subject to their terms, and we are not responsible for
    them.</p>

    <h2>14. Termination</h2>
    <p>You can stop using the Service and delete your account at any time from the app; storage used
    up to that moment is billed. We may suspend or close your account if you break these Terms, if a
    bill stays unpaid as described in section 7, or to protect the Service or other users. Sections
    that by their nature should survive termination continue to apply.</p>

    <h2>15. Disclaimers</h2>
    <p>The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranties
    of any kind, express or implied, including merchantability, fitness for a particular purpose,
    non-infringement, and uninterrupted or error-free operation, to the fullest extent the law
    allows.</p>

    <h2>16. Limitation of Liability</h2>
    <p>To the fullest extent the law allows, ${company} is not liable for any indirect, incidental,
    special, consequential, or punitive damages, or for any loss of data, profits, or goodwill. Our
    total liability for any claim relating to the Service is limited to the amount you paid us in the
    12 months before the claim.</p>

    <h2>17. Indemnification</h2>
    <p>You agree to indemnify and hold ${company} harmless from claims and expenses arising from your
    files, your use of the Service, or your breach of these Terms or of any law or third-party
    right.</p>

    <h2>18. Governing Law</h2>
    <p>These Terms are governed by the laws of ${TERMS_GOVERNING_LAW}, without regard to its
    conflict-of-laws rules. You agree to the exclusive jurisdiction of the courts located there,
    except where the law does not allow it.</p>

    <h2>19. Changes to These Terms</h2>
    <p>We may update these Terms. We will change the &ldquo;Last updated&rdquo; date above and, for
    material changes, tell you in the app or by email before they take effect. If you keep using the
    Service after that, you accept the updated Terms.</p>

    <h2>20. Contact Us</h2>
    <p>Questions about these Terms? Contact us at <a href="mailto:${email}">${email}</a>.</p>`;

  return renderLegalPage(`${app} Terms of Service`, TERMS_EFFECTIVE_DATE, body);
}

/**
 * Account-deletion page — the "Delete account URL" on the Google Play store listing.
 *
 * Play requires this page to (1) name the app and developer as they appear on the listing, (2) put
 * the steps to request deletion front and centre, and (3) say which data is deleted, which is kept,
 * and for how long. It must also work for someone who no longer has the app, hence the email route
 * next to the in-app one.
 *
 * The in-app route is DELETE /api/v1/me, which requires a fresh Google sign-in for the same account
 * (hence the "confirm it's you" step). Since P1 it anonymises the account and signs out every device;
 * files are purged from P3, the final bill and mandate cancellation from P5. The retained list must
 * match what genuinely survives that call — if deletion behaviour changes, change this page in the
 * same commit.
 */
export function renderDeleteAccount(): string {
  const app = LEGAL_APP_NAME;
  const company = LEGAL_COMPANY;
  const email = LEGAL_CONTACT_EMAIL;

  // TODO(app): the Option 1 steps must name the screens the shipped app actually has — a reviewer
  // follows them literally, and steps that don't match get the listing rejected. Confirm the
  // Settings → Account → Delete account path through the contract folder once the screen exists.

  const body = `<p>This page explains how to delete your <strong>${app}</strong> account and the
    data associated with it. ${app} is published by <strong>${company}</strong>, the developer named
    on our Google Play store listing.</p>

    <p>You can delete the account yourself in the app, or email us a request if you no longer have
    the app installed. Both remove the same data.</p>

    <div class="callout warn">
      <p><strong>Download anything you want to keep first.</strong> Deleting your account permanently
      deletes every file and folder in it, and every share link you created stops working. This
      cannot be undone, and we cannot restore a deleted account.</p>
    </div>

    <h2>Option 1 — Delete your account in the app</h2>
    <div class="callout">
      <ol class="steps">
        <li>Open the <strong>${app}</strong> app and make sure you are signed in to the account you
          want to delete.</li>
        <li>Open <strong>Settings</strong>.</li>
        <li>Tap <strong>Account</strong>.</li>
        <li>Tap <strong>Delete account</strong>.</li>
        <li>Read the confirmation message and tap <strong>Delete</strong>.</li>
        <li>Confirm it&rsquo;s you by choosing your Google account when asked.</li>
      </ol>
    </div>
    <p>Your account is closed <strong>immediately</strong> and every device is signed out. Your files
    are removed from our storage within <strong>${DELETION_STORAGE_PURGE_DAYS} days</strong>.</p>

    <h2>Option 2 — Request deletion by email</h2>
    <p>Use this if you have uninstalled the app or cannot sign in.</p>
    <div class="callout">
      <ol class="steps">
        <li>Email <a href="mailto:${email}?subject=Delete%20my%20account">${email}</a> from the email
          address of the Google account you use with ${app}.</li>
        <li>Use the subject line <strong>Delete my account</strong>.</li>
        <li>Reply to our confirmation message, if we send one &mdash; we may need to check that the
          account is yours before we delete it, so that nobody else can delete it for you.</li>
      </ol>
    </div>
    <p>We complete verified requests within <strong>${DELETION_REQUEST_SLA_DAYS} days</strong>, and
    usually much sooner. We will email you once it is done.</p>

    <h2>Your final bill and auto-pay</h2>
    <p>Storage used up to the moment of deletion is billed on a final statement, charged to your
    auto-pay mandate if you have one, or otherwise by payment link. We then <strong>cancel your
    auto-pay mandate</strong> ourselves; you can also revoke it in your UPI or banking app. Unused
    Google Play credits are lost and are not refunded, except where Google Play&rsquo;s policies or
    the law require it.</p>

    <h2>What is deleted</h2>
    <p>Deleting your account permanently removes:</p>
    <ul>
      <li><strong>Your account details</strong> &mdash; your email address, name, profile photo, and
        the Google account identifier linked to ${app}.</li>
      <li><strong>All your files and folders</strong>, including everything in Trash, and their
        preview images &mdash; deleted from our storage provider.</li>
      <li><strong>Your share links</strong>, which stop working immediately.</li>
      <li><strong>Your signed-in devices</strong> and notification tokens.</li>
      <li><strong>Your auto-pay settings.</strong></li>
    </ul>

    <h2>What is kept, and for how long</h2>
    <p>After your account is deleted we keep only the following. None of it identifies you by name
    or email once your account is gone:</p>
    <ul>
      <li><strong>Billing and payment records</strong> (up to
        <strong>${DELETION_BILLING_RETENTION_YEARS} years</strong>) &mdash; your statements and
        payments, the records our payment providers send us, and the record of how much storage
        your account used over time that your bills were calculated from (amounts and dates, never
        file names or contents), kept against an internal identifier to meet tax, accounting, and
        fraud-prevention obligations.</li>
      <li><strong>Operational logs</strong> (up to <strong>${DELETION_LOG_RETENTION_DAYS}
        days</strong>) &mdash; technical records such as IP addresses and request details that we
        use to run and secure the Service. They are deleted automatically after this period.</li>
      <li><strong>Encrypted backups</strong> (up to <strong>${DELETION_BACKUP_RETENTION_DAYS}
        days</strong>) &mdash; deleted records may remain in routine database backups until those
        backups expire. They are never used to restore your account.</li>
      <li><strong>Anonymous, aggregated statistics</strong> that cannot be linked back to you.</li>
    </ul>
    <p>Some things are outside our control. Copies of files you downloaded, and files other people
    downloaded through your share links, are not affected by deletion. Purchase records held by
    <strong>Google Play</strong> are governed by Google&rsquo;s own policies.</p>

    <h2>Questions</h2>
    <p>If you have any questions about deleting your account or your data, contact us at
    <a href="mailto:${email}">${email}</a>. You can also read our
    <a href="${LEGAL_PATHS.privacy}">Privacy Policy</a> and
    <a href="${LEGAL_PATHS.terms}">Terms of Service</a>.</p>`;

  return renderLegalPage(`Delete your ${app} account`, DELETE_ACCOUNT_EFFECTIVE_DATE, body);
}
