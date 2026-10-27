# BenchBox Backend — Implementation Plan

**Status:** draft for review · **Date:** 2026-10-01 · **Slug:** `benchbox` · **Domain:** `benchbox.ferbotz.com`

BenchBox is a pay-as-you-use cloud storage app. Users keep files and folders in the cloud. Each month they
pay for the storage they actually used, through an auto-debit mandate with a cap they choose. The client
is Kotlin Multiplatform, launching on Android first.

This backend follows the HOA protocols (`G:\My Drive\HOA Protocols\`). Every deviation is listed with its
reason in §2.

---

## 0. Decisions so far

| Topic | Decision | Source |
|---|---|---|
| Billing model | **Postpaid, capped by a mandate.** The user approves a UPI AutoPay / card mandate with a cap (e.g. ₹100). Each month BenchBox debits the actual usage, up to the cap. The user is alerted as usage nears or passes the cap. | Product decision |
| Payments | Razorpay recurring payments for the mandate (new vendor). Google Play credit packs via RevenueCat (house pattern), required for Play compliance (§7.6). | §7.6 |
| File storage | Cloudflare R2: one private bucket, Asia-Pacific location hint. | Product decision |
| v1 features | Folders, upload/download, trash, search, sync feed, **share links** | Product decision |
| Platforms | Android first, with Google sign-in only. iOS later (adds Sign in with Apple). | Product decision |
| Stack | HOA protocol 04: Express 5, TypeScript strict/CJS, Prisma 6, PostgreSQL, Node 22, Docker | House standard |

**Storage options considered (2026-10-01):**

| Option | Verdict |
|---|---|
| AWS S3 (house default) | Rejected. Download fees (~$0.09/GB) would dominate a pay-as-you-use price. |
| Google Drive API, every user's files in one BenchBox account | Rejected. Google's terms forbid reselling the service. One account suspension would take every user offline. Hard caps: 750 GB of uploads per account per day, and 500,000 items per shared drive. No signed download links, so every download would have to pass through our server. |
| Google Drive API, each user's own Drive | Works technically, but the files use storage the user buys from Google, so BenchBox would have nothing to bill for. That is a different product. |
| Google Cloud Storage | Built for this (signed URLs, Mumbai region), but like S3 it charges per GB downloaded. |
| Backblaze B2 | About half R2's storage price, but US/EU regions only. A candidate for a later disaster-recovery copy. |
| **Cloudflare R2** | **Chosen.** Free downloads, APAC placement, S3 API. Designed for 99.999999999% durability across several data centers, so file bytes need no separate backup. The Postgres database still does (§11). |

---

## 1. Architecture

```
                 ┌──────────────────────── shared EC2 box ─────────────────────────┐
  KMM app ──────▶│ nginx ─▶ app     Express 5: /api/v1, /config, legal, /s/:token, │
   │  JSON/HTTPS │          │       /webhooks/*, /admin                            │
   │             │          │                                                      │
   │             │        worker   scheduled jobs + outbox (same image)            │
   │             │          │                                                      │
   │             │        Postgres (host)  metadata · storage log · ledger         │
   │             └──────────┼────────────────────┬───────────────────┬────────────┘
   │                        │ S3 API             │ REST + webhooks    │
   │  presigned URLs        ▼                    ▼                    ▼
   └──────────────────▶ Cloudflare R2      Razorpay · RevenueCat   FCM push · SES email
     (file bytes only)  private bucket     Play Developer API
```

Four rules shape everything else:

1. **File bytes never pass through our server.** The app uploads to R2 and downloads from it directly, using
   short-lived presigned URLs. The API only handles metadata, permissions, metering and billing. That keeps
   a small EC2 box viable.
2. **Every change to stored bytes goes through one function.** Uploads, replacements, purges and account
   deletion all call `metering.recordStorageChange()` inside the same DB transaction as the metadata change.
   It appends a `StorageEvent`. Bills are computed from that append-only log, so they can be recomputed and
   audited at any time.
3. **Money is computed only on the server**, using protocol 04's money rules: paise in `BigInt`,
   `decimal.js`, half-up rounding, strings on the wire. The app shows the strings it receives.
4. **Everything retries safely.** The app generates UUIDs for folders, files and uploads. Every billing row
   has a unique key. Webhooks are de-duplicated by event id.

---

## 2. House protocols: followed and deviated

**Followed as-is:**
- The `{ success, data }` / `{ success:false, message, code }` envelope, with `AppError` subclasses and one
  error handler.
- Layering: route → controller → service → repository. Prisma is used only in repositories.
- One file per external SDK.
- `config/env.ts` is the only reader of `process.env`, and the app fails fast on bad config. Optional
  integrations need all of their keys or none; with none, their endpoints return 503.
- A foreign or missing row returns 404, never 403.
- Client UUIDs, idempotent by `(userId, id)`.
- Soft-delete tombstones.
- Money rules (as in Billanta's `MONEY.md`).
- `tsc --noEmit` plus `check:*` scripts.
- `GET /config` (protocol 10), legal pages (protocol 12) and the contract folder (protocol 01).
- Docker and compose with a separate `migrate` service, and the deploy runbook (protocol 05).
- Momentica's in-memory rate limiter.

**Deviations (protocol 04 asks for a written reason):**

| # | House default | BenchBox | Reason |
|---|---|---|---|
| D1 | Access JWT never expires; no refresh tokens | 1-hour access JWT, plus a rotating refresh token for each device (Billanta's `auth.service.ts` pattern). Supports "sign out other devices" and bans. | Protocol 04 itself says to reinstate expiry for payment and sensitive surfaces. BenchBox holds private files and a mandate on the user's bank account. The KMM client's Ktor `Auth` plugin refreshes silently, so users never see a timed logout. |
| D2 | S3 `<app>-media`, public-read; multer + sharp inside the request; 8 MB cap | R2 private bucket. Presigned direct upload and download, multipart for large files. Originals are stored byte-for-byte. | Files are the product: up to GBs, private, and never re-encoded. Proxying them would saturate the shared box. S3's download fees would dominate a pay-as-you-use price. |
| D3 | The server makes thumbnails with sharp | The app makes a ≤512 px WebP thumbnail and uploads it alongside the file | Keeps CPU and RAM off the shared box. The phone already decodes HEIF and video. |
| D4 | The sync cursor and last-write-wins key is the client's `updatedAt` | No client clocks anywhere. The *cursor* is a sequence number the server assigns per user, and changes apply in arrival order. An optional `ifSeq` precondition (409 `NODE_CHANGED`) protects replayed offline edits. Client UUIDs (idempotent by id) and tombstones stay as in protocol 04. | Many changes start on the server: upload completion, trash auto-purge, takedowns. Device clocks drift, so comparing them with server times would silently drop real edits. A server sequence never skips a change. |
| D5 | Scheduled scripts run from the host crontab | A long-running `worker` service with a small scheduler, Postgres advisory locks and a `JobRun` table | There are about 10 recurring jobs, some every minute. Billing jobs must run exactly once and be observable. One container is lighter than cron starting a container per run. |
| D6 | RevenueCat is the only payment provider | Razorpay recurring (the mandate) plus RevenueCat (Play credit packs) | The chosen billing model needs mandates, and Play policy needs Play billing offered alongside it (§7.6). |
| D7 | No push or email infrastructure | FCM (`firebase-admin`) and Amazon SES (`@aws-sdk/client-sesv2`), each behind one file | Billing alerts must reach users who don't open the app: cap reached, bill due, suspension and deletion warnings. |

---

## 3. Codebase layout (Billanta/Curiously style)

```
src/
  app.ts                      HTTP entry
  worker.ts                   job runner entry (same image, different command)
  config/env.ts               the only reader of process.env
  common/                     errors, response, validation, pagination, rateLimit,
                              auth middleware, money.ts, bytes.ts, time.ts (IST helpers)
  storage/r2Storage.ts        sole importer of @aws-sdk/client-s3 + s3-request-presigner
  integrations/               razorpay.ts · revenueCat.ts · googleVerifier.ts ·
                              playExternalTx.ts · fcm.ts · ses.ts   (one SDK each)
  modules/
    auth/ account/ nodes/ files/ (uploads, downloads, reconcile) sync/ shares/
    metering/ outbox/ billing/ payments/ notifications/
    remoteConfig/ legal/ admin/ jobs/
      <module>.routes.ts + controller/ service/ repository/ dto/
  scripts/check-*.ts          check:metering, check:statement, check:money, check:tree, …
prisma/schema.prisma
docs/                         ARCHITECTURE.md, MONEY.md (metering + billing rules), API.md,
                              REMOTE_CONFIG.md, DEPLOY.md
```

---

## 4. Data model (Prisma sketch)

```prisma
model User {
  id          String    @id @default(uuid()) @db.Uuid
  googleSub   String    @unique
  email       String
  name        String?
  standing    Standing  @default(GOOD)   // GOOD | PAST_DUE | SUSPENDED | DELETION_SCHEDULED | CLOSED
  storedBytes BigInt    @default(0)      // live total = last StorageEvent.totalAfter
  syncSeq     BigInt    @default(0)      // last sync sequence handed out (D4)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
}

model Session {                          // one per signed-in device (D1)
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  refreshTokenHash String    @unique     // sha256 of the opaque token; reuse ⇒ revoke session
  deviceName       String?
  platform         String
  lastUsedAt       DateTime
  expiresAt        DateTime              // sliding, e.g. 90 days
  revokedAt        DateTime?
}

model Node {                             // a file or a folder
  id          String    @id @db.Uuid     // generated by the app
  userId      String    @db.Uuid
  parentId    String?   @db.Uuid         // null = root
  kind        NodeKind                   // FOLDER | FILE
  name        String
  nameKey     String                     // NFC + lowercase: uniqueness + search
  blobId      String?   @db.Uuid         // files: current content
  size        BigInt    @default(0)
  mimeType    String?
  trashedAt   DateTime?
  trashRootId String?   @db.Uuid         // the node the user trashed (restore unit)
  deletedAt   DateTime?                  // tombstone after purge, kept 90 days for sync
  hasThumbnail Boolean  @default(false)  // the blob has a thumbnail (denormalised for every read)
  syncSeq     BigInt                     // per-user change sequence
  updatedAt   DateTime                   // server clock (D4: no client clocks)
  createdAt   DateTime  @default(now())
  @@index([userId, syncSeq])
  @@index([userId, parentId])
  // raw-SQL migration: UNIQUE (userId, parentId, nameKey) WHERE trashedAt IS NULL AND deletedAt IS NULL
  // raw-SQL migration: GIN trigram index on nameKey (pg_trgm is a trusted extension, no superuser needed)
}

model Blob {                             // one object in R2
  id        String    @id @db.Uuid       // = the id of the upload that created it
  userId    String    @db.Uuid
  bucket    String                       // lets us change bucket/provider later without a rewrite
  objectKey String    @unique            // u/{userId}/{blobId}   (never contains the file name)
  thumbKey  String?   @unique            // t/{userId}/{blobId}.webp   (not billed)
  size      BigInt                       // from HeadObject, never from the client
  createdAt DateTime  @default(now())
  purgedAt  DateTime?                    // billing stopped; the object's deletion is in the outbox
}

model UploadSession {
  id           String      @id @db.Uuid  // generated by the app → retries return the same session
  userId       String      @db.Uuid
  fileId       String      @db.Uuid      // the new file's id (a replacement keeps the old file's)
  parentId     String?     @db.Uuid
  name         String
  mimeType     String
  declaredSize BigInt
  onConflict   String                    // fail | rename | replace
  objectKey    String      @unique       // reserved BEFORE any URL is issued → no untracked objects
  thumbSize    Int?                      // declared thumbnail size; null = none
  r2UploadId   String?                   // multipart only
  partSize     Int?
  partCount    Int?
  state        UploadState               // PENDING | COMPLETED | ABORTED | EXPIRED | FAILED
  resultNodeId String?     @db.Uuid
  expiresAt    DateTime                  // slides with activity: idle 24 h, at most 6 days
  createdAt    DateTime    @default(now())
  endedAt      DateTime?
}

model StorageEvent {                     // append-only; the metering source of truth
  id         BigInt   @id @default(autoincrement())
  userId     String   @db.Uuid
  at         DateTime
  deltaBytes BigInt
  totalAfter BigInt
  reason     String                      // UPLOAD | REPLACE | PURGE | ACCOUNT_DELETE | ADMIN
  refId      String?
  @@index([userId, id])                  // a user's events in id order = commit order (row lock)
  @@index([userId, at])
}

model UsageDay {                         // one row per user per IST day (built in P4)
  userId              String   @db.Uuid
  day                 DateTime @db.Date
  byteSeconds         Decimal  @db.Decimal(38, 3)  // exact: event times are milliseconds
  billableByteSeconds Decimal  @db.Decimal(38, 3)  // above the day's free allowance
  peakBytes           BigInt
  endBytes            BigInt             // starting value for the next day
  lastEventId         BigInt             // the next day reads the log after it
  chargeMicroPaise    BigInt             // exact daily charge, in millionths of a paisa
  priceBookId         String   @db.Uuid
  @@id([userId, day])
  // downloadBytes (fair-use monitoring, §5.2) is not built yet
}

model PriceBook {                        // built in P4; seeded with the §13 defaults
  id                     String   @id @default(uuid()) @db.Uuid
  effectiveFrom          DateTime @unique @db.Date  // the 1st of an IST month (a CHECK)
  storagePaisePerGbMonth BigInt            // 250 = ₹2.50
  freeBytes              BigInt            // e.g. 2_000_000_000; also the storage allowance
  gstBasisPoints         Int               // 1800 = 18%
  minimumChargePaise     BigInt            // smaller totals are carried into the next statement
  note                   String?
  createdAt              DateTime          // an increase's notice period starts here (§7.1)
}

model BillingAccount {                   // P4 builds the limit; P5 the rest
  userId              String       @id @db.Uuid
  monthlyLimitPaise   BigInt?               // = the mandate's max_amount (the "cap"; users see "limit")
  mandateState        MandateState @default(NONE)  // NONE | PENDING | ACTIVE | PAUSED | CANCELLED | REJECTED
  mandateMethod       String?               // UPI | CARD | EMANDATE
  razorpayCustomerId  String?
  razorpayTokenId     String?
  playExternalTxToken String?               // from Play's user choice screen (§7.6)
  balancePaise        BigInt       @default(0)  // + credit, − owed; = last LedgerEntry.balanceAfter
}

model Statement {                        // one per user per IST calendar month (built in P4)
  id                     String          @id @default(uuid()) @db.Uuid
  userId                 String          @db.Uuid
  periodStart            DateTime        @db.Date
  periodEnd              DateTime        @db.Date
  byteSeconds            Decimal                 // the month's usage; GB-days/months are shown from these
  billableByteSeconds    Decimal
  priceBookId            String          @db.Uuid  // with its price, GST rate and minimum copied in
  subtotalPaise          BigInt
  gstPaise               BigInt
  carriedInPaise         BigInt                  // an earlier sub-minimum total, carried in
  totalPaise             BigInt
  status                 StatementStatus         // P4: OPEN | CARRIED; P5 adds COLLECTING | PAID | PAST_DUE | WAIVED
  carriedIntoId          String?         @unique // a CARRIED statement: the one that took its total
  dueAt                  DateTime?               // P5
  @@unique([userId, periodStart])
}

model LedgerEntry {                      // append-only money movements (AuraPix CreditTransaction pattern)
  id           String     @id @default(uuid()) @db.Uuid
  userId       String     @db.Uuid
  type         LedgerType                // STATEMENT | MANDATE_DEBIT | LINK_PAYMENT | PLAY_CREDIT | REFUND | ADJUSTMENT
  amountPaise  BigInt                    // signed
  balanceAfter BigInt
  referenceId  String
  note         String?                   // required for ADJUSTMENT
  createdAt    DateTime   @default(now())
  @@unique([userId, type, referenceId])
}

model Payment {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  statementId      String?   @db.Uuid
  kind             String              // MANDATE_DEBIT | PAYMENT_LINK | MANDATE_AUTH | PLAY_CREDIT
  attempt          Int       @default(1)
  provider         String              // RAZORPAY | REVENUECAT
  providerRef      String?   @unique   // Razorpay order/payment id or store transaction id
  amountPaise      BigInt
  status           String              // CREATED | NOTIFIED | CAPTURED | FAILED | REFUNDED
  reportedToPlayAt DateTime?           // alternative-billing report (§7.6)
  createdAt        DateTime  @default(now())
  @@unique([statementId, kind, attempt])   // written BEFORE calling Razorpay → no double debit
}

model ShareLink {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @db.Uuid
  nodeId     String    @db.Uuid
  tokenHash  String    @unique   // sha256 of 32 random bytes; the token itself is never stored
  expiresAt  DateTime?
  revokedAt  DateTime?
  disabledAt DateTime?           // admin takedown
  downloads  Int       @default(0)
  createdAt  DateTime  @default(now())
}

// Small supporting tables: WebhookEvent @@id([provider, eventId]) · Notification (dedupeKey @unique,
// type, payload, push/email delivery state; P4) · AbuseReport · OutboxJob (kind, payload, runAfter,
// attempts) · JobRun @@id([name, periodKey]). FCM tokens live on Session.pushToken (P1), not in a
// DeviceToken table: a signed-out device stops getting notifications.
```

---

## 5. File flows

### 5.1 Upload (direct to R2, resumable) — built in P3

1. `POST /api/v1/uploads` with `{ id, fileId, parentId, name, size, mimeType, onConflict, thumbnail? }`.
   - Checked before any bytes move: parent ownership, the name (`fail` refuses a clash now), and
     `size ≤ limits.maxFileSizeBytes`. The server obeys the **resolved** remote config, so an env
     override changes the limit and what the app is told together.
   - Under the user's row lock: at most 50 unfinished uploads, and the **storage allowance**: stored
     bytes + what other unfinished uploads reserve + this file − the file it replaces must fit. Until
     billing (P5) the allowance is the free tier; an active mandate or credit will lift it.
   - It writes a `PENDING` UploadSession with the object key reserved. Files ≤ 16 MiB get one presigned
     PUT; larger ones get an R2 multipart upload, opened at once, and `partSize`/`partCount`.
   - **Every presigned upload URL signs `Content-Length`**: R2 refuses a body of any other size. The
     SDK runs with checksums `WHEN_REQUIRED`, so no checksum parameters leak into the URLs.
   - Deferred to P4, then again to P5 (2026-10-27): the projected month-end bill in this response. It
    only matters once an account can pass the free tier and has a limit; until then the billing
    summary's projection covers it.
2. `POST /api/v1/uploads/:id/parts { partNumbers }` returns presigned `UploadPart` URLs (≤ 1 h), up to 50
   per call, each signed for its part's exact size. R2 requires every part but the last to be the same
   size: 8 MiB, raised for very large files to stay under 10,000 parts.
3. The app PUTs the parts straight to R2, 3–4 in parallel. It needn't keep ETags: completion lists
   the parts itself.
4. To resume after a network drop or app kill, `GET /api/v1/uploads/:id` calls `ListParts` and returns
   the part numbers R2 holds at the right size; the app sends only the rest.
5. `POST /api/v1/uploads/:id/complete { onConflict? }`:
   1. Multipart: `ListParts`; every part must be there at its exact size, then
      `CompleteMultipartUpload`.
   2. `HeadObject`: **the billed size is R2's**. A mismatch marks the session `FAILED` and queues the
      cleanup.
   3. The thumbnail is checked with `HeadObject` too; its absence never fails the upload.
   4. One transaction under the user's lock: claim the completion (a conditional update, so a racing
      cancel or second complete can't also win) → the folder, or the root if it was deleted or trashed
      meanwhile → the name clash (`fail` answers 409 and leaves the upload pending, so the app can
      complete again choosing `rename`/`replace`) → `Blob`, `StorageEvent` (+bytes), the file `Node`
      with this transaction's `syncSeq`, the result on the session.

   Idempotent: a completed upload answers with its file. A crash between R2's completion and the
   commit is recovered: `ListParts` then says the upload is gone, and `HeadObject` finds the object.
6. `DELETE /api/v1/uploads/:id` cancels. Presigned URLs can't be revoked, so the cleanup (abort the
   multipart upload, then delete the keys) waits until every URL issued has expired (1 h + 15 min);
   aborting first means no late part can complete into an object after the delete. The
   `uploads.expire` job (every 15 min) expires uploads idle for 24 h, or 6 days old however active,
   and cleans up at once. R2 buckets come with a default rule that expires unfinished multipart uploads
   after 7 days, the last backstop. Because the key is reserved before any URL is issued, the bucket
   never gets objects the database doesn't know about (the Momentica orphan gap).

**Replace** (`onConflict=replace`, no version history in v1): the existing **file** keeps its id,
name and place and points at the new blob; the old blob is purged in the same transaction (a `REPLACE`
event, −bytes), and its objects go through the outbox. A folder is never replaced: the file is numbered.

### 5.2 Downloads and thumbnails — built in P3

- `GET /api/v1/files/:id/download` returns a presigned GET valid for 15 min, answering with the real
  name (`response-content-disposition`, ASCII fallback + RFC 5987 UTF-8) and type, because object keys
  are opaque. R2 handles `Range` requests, so downloads resume and videos can seek. Trashed files
  download too: they are still stored, and still billed.
- **Thumbnails:** `GET /api/v1/files/:id/thumbnail` is a stable per-file URL answering 302 to a
  presigned GET (1 h). The node carries `hasThumbnail` and `contentId` (its blob id, which changes only
  with the content), and the app's image loader caches by `contentId`. *Changed from the first plan*
  (presigned URLs embedded in listings): the app shows folders from its Room cache, filled by the sync
  feed, which can't hold URLs that expire in an hour.
- Moved to P4 (it needs `UsageDay`), then left out of it (2026-10-27): adding each download's size to
  `downloadBytes` for fair-use monitoring. It needs a retention decision first: `UsageDay` survives
  account deletion as a billing record, so it would keep download history too, which the
  delete-account page doesn't list. Downloads stay free in v1.

### 5.3 Trash, purge and object deletion

- **Trash:** sets `trashedAt` on the whole subtree with `trashRootId = id`. **Trashed files still count
  as stored** until purged, and the app shows the trash size (`GET /api/v1/me/storage`).
- **Subtree walks** go one tree level per query (`parentId = ANY(level)` on the `parentId` index). The
  recursive CTE used first was planned from table statistics, and when one huge folder dominated them
  the planner scanned the whole table once per folder on the frontier: a 70,000-file folder took
  minutes. Level by level it takes about 3 s, and check:storage-db pins 20,000 files.
- **Restore:** returns the node to its original parent, or to root if that parent is gone. Name clashes
  are renamed to "name (1)".
- **Purge:** happens by user action or after 30 days in trash. In one transaction it tombstones the
  nodes, marks their blobs purged, records one `PURGE` event (−bytes) and queues `DELETE_OBJECTS`
  outbox jobs (1,000 keys each). The user stops paying at the moment of purge; the `outbox.drain` job
  (every minute) deletes the objects, retrying with backoff (1 min doubling to 1 h) until it succeeds.
- **Account deletion:** in one transaction, every blob is purged (an `ACCOUNT_DELETE` event), the tree
  and the upload sessions are deleted, and two sweeps of the account's prefixes are queued: one now,
  one after every URL issued before the deletion has expired. That keeps the delete-account page's
  "removed within 7 days" promise with days to spare.
- **Move:** a walk up the parents rejects moving a folder into its own subtree. A per-user row lock
  serializes tree changes for each user.
- **Reconciliation (`storage.reconcile`, daily, report-first):** per account prefix in the bucket, and
  per account with live blobs:
  - it fixes only provable garbage: objects of purged blobs and ended uploads are queued for deletion,
    a deleted account's prefixes are swept again, multipart uploads no pending session waits for are
    aborted;
  - it reports, as `ALERT` in the job summary and the log: `User.storedBytes` ≠ the sum of unpurged
    blobs ≠ the last `StorageEvent.totalAfter`; a live file without content or content without a file;
    keys BenchBox never issued; and **missing objects** (a live blob whose object is gone: data loss).

### 5.4 Sync feed (for the app's Room cache)

`GET /api/v1/sync/changes?cursor=&limit=500` returns `{ changes, nextCursor, hasMore }`.
- **Changes:** each one is a full node snapshot, including tombstones (purged nodes, names cleared).
- **Ordering:** every tree transaction takes the user's row lock and increments `User.syncSeq` first,
  then stamps every node it touches with that one value. Feed order (syncSeq, id) is therefore commit
  order.
- **The cursor** is (syncSeq, id, floor-when-issued). At the end of a pass it jumps to the account's
  committed sequence (any later commit gets a higher one), so it never stalls below the floor.
- **Compaction:** tombstones are kept 90 days, then compacted, which raises `User.syncFloor`. A device
  gets `410 RESYNC_REQUIRED` only when compaction happened *after* its cursor was issued AND the cursor
  hasn't passed the floor. A full sync walking old rows below the floor is never interrupted.
  (`check:tree-db` caught the first version breaking exactly that.)

### 5.5 Share links (v1)

- `POST /api/v1/shares { nodeId, expiresIn, allowDownload }` returns `https://benchbox.ferbotz.com/s/<token>`.
  - The token is 32 random bytes, and only its sha256 is stored (Momentica's opaque-token rule).
  - Links expire after 7 days by default. The owner can revoke them, and admins can disable them.
- The public routes are mounted at root and need no auth:
  - `GET /s/:token` serves a self-contained HTML page (like the legal pages) with `X-Robots-Tag: noindex`.
    Link-preview crawlers get a minimal page and are never redirected (Curiously's rule).
  - `GET /s/:token/items` lists a shared folder.
  - `GET /s/:token/download[/:fileId]` returns a **302** to a presigned URL valid for 5 minutes.
  - `POST /s/:token/report` files an abuse report.
- `/.well-known/assetlinks.json` (it must return 200 JSON) lets Android open links in the app.
- Every access checks the link's state, the owner's standing (links stop when SUSPENDED) and the rate
  limits (per IP and per link, plus a daily download cap per link).
- Curiously deliberately didn't ship private-content share tokens before a privacy review, so **a privacy
  review is an exit criterion for this feature** (§12).

---

## 6. Metering: how pay-as-you-use is measured

**What is billed:** every file the user has, *including files in Trash*, from the moment its upload
completes until it is purged.

**Not billed:** thumbnails, unfinished uploads and metadata.

**1 GB = 10⁹ bytes**, the same unit Android and iOS use to show file sizes.

Storage is a step function over time. Every change writes a `StorageEvent` (`delta`, `totalAfter`, `at`)
under the user's lock. The **daily close** (00:10 IST, so in-flight transactions have committed)
integrates that function:

```
byteSeconds(day) = Σ over the day's intervals of  storedBytes × seconds
chargeable       = max(0, byteSeconds − freeBytes × 86,400)
charge(day)      = chargeable ÷ (10⁹ × 86,400) × pricePerGBMonth ÷ daysInThisMonth
```

The exact charge is kept in micro-paise (`BigInt`), and the statement rounds once (half-up). Pricing per
day of the actual month means flat usage costs exactly the advertised monthly price in every month.

**As built (P4, 2026-10-27):**
- The free allowance is per day, as the formula says: a day is billed only for its byte-seconds
  above `freeBytes × 86,400`, so storage can swing within a day (4 GB for half a day is free).
- The log is walked in id order (commit order: events are written under the user's row lock). An
  event takes effect at max(its `at`, the previous event's effect), so time never runs backwards; one
  that commits after its day was closed counts from the next day's start.
- Each `UsageDay` records where the next day starts (`endBytes`, `lastEventId`), so a close resumes
  from the newest closed day and never rewrites one: re-running it writes nothing. A day with nothing
  stored and no events gets no row.
- Prices come from the `PriceBook` row for the day's month (§7.1).

**Worked example** (₹2.50/GB-month, 2 GB free, 30-day month). A user stores 10 GB for 20 days, then 30 GB
for 10 days:

| Step | Amount |
|---|---|
| Total usage (10 × 20 + 30 × 10) | 500 GB-days |
| Minus the free tier (2 GB × 30 days) | 440 GB-days ≈ 14.67 GB-months |
| Storage charge | ₹36.67 |
| GST at 18% | ₹6.60 |
| Total, auto-debited because it is under a ₹100 cap | **₹43.27** |

`check:metering` pins this example and the edge cases, as Billanta's `check:money` does:
- uploads at 23:59
- a purge in the middle of the day
- a price change at the start of a month
- a 31-day month
- usage at the free-tier boundary
- a day with no events

**Live numbers:**
- **Month-to-date** = closed days + today so far, computed from the live counter. As built: the days
  not closed yet are walked from the log exactly as the close will walk them, and today so far gets
  the whole day's free allowance, so month-to-date is "the bill if the month ended now": it never
  goes down, and equals the closed numbers once the day closes (`check:billing-db` compares them).
- **Projection** = month-to-date + current bytes × remaining time × rate.

Both are served by `GET /api/v1/billing/summary` and drive the cap alerts. Both include GST and any
carried amount (§7.2): they are what auto-pay would be asked for.

**Downloads** are free, because R2 charges nothing for downloads. Metering them
(`UsageDay.downloadBytes`) for a later fair-use price (e.g. above 3× stored) is not built (§5.2).

---

## 7. Billing: the capped mandate

### 7.1 Pricing and unit economics

`PriceBook` rows are versioned by `effectiveFrom`. A price change applies from the next cycle, announced at
least 30 days ahead (stated in the Terms). As built (P4): `effectiveFrom` is always the 1st of a month
(a CHECK), so a month has one price, and an increase (a higher price per GB-month or a smaller free
allowance) waits until the first month starting at least 30 days after its row was recorded,
whatever its `effectiveFrom` says. The migration seeds the suggested defaults below as the first row,
effective October 2026. Example numbers, all to be decided (§13):

| Per GB-month | Amount |
|---|---|
| R2 storage cost | $0.015 ≈ ₹1.3 (at ~₹88/$) |
| Example price | ₹2.50 + 18% GST |
| Fees on the mandate path: Razorpay (~2%, confirm UPI AutoPay pricing) + Google's alternative-billing fee (~11%, §7.6) | ≈ ₹0.33 |
| **Gross margin before operations** | **≈ ₹0.87 (≈35%)** |

R2 operation fees ($4.50 per million writes, $0.36 per million reads) are negligible at these file sizes.
Per-user upload rate limits stop anyone from running them up.

### 7.2 Cycle and statement

- The billing cycle is the **calendar month in IST** (`Asia/Kolkata`, a fixed +05:30 offset). All
  timestamps are stored in UTC, and day boundaries are computed in `time.ts`.
- On the 1st at 00:30 IST, each user's statement closes:
  - `subtotal = round_half_up(Σ daily micro-paise)`
  - `GST = round_half_up(subtotal × 18%)`
  - `total = subtotal + GST + carriedIn`
- A `STATEMENT −total` ledger entry is written. (Not in P4, which has no ledger: P5's settlement writes
  it for each statement it collects.)
- If the total is below the minimum debit (e.g. ₹10), the statement is `CARRIED` into next month instead of
  debited.

As built (P4, `billing.closeCycle`): the job runs monthly from the 1st at 00:30 and bills every
month that has ended and has no statement, oldest first, so an outage is caught up. A `CARRIED`
total goes into the account's **next statement**, whenever that is (`carriedIntoId` records where):
a month with no usage makes no statement just to carry it. A month whose charges come to under half
a paisa (within the free tier) gets no statement. `OPEN` statements get a bill-ready notification.

### 7.3 Mandate setup and cap changes

- The free tier works without a mandate. To store more, the user picks a **monthly cap**: ₹100 by default,
  with presets and a custom amount.
  1. The app calls `POST /api/v1/billing/mandate { capPaise, method, externalTransactionToken }`.
  2. The backend creates a Razorpay customer (once) and a **registration link**: UPI AutoPay, card or
     eNACH, with `max_amount = cap`, `frequency = as_presented` and a long expiry.
  3. The app opens the link, and the user approves it with their UPI PIN or card.
  4. A `token.confirmed` webhook arrives. The backend re-fetches the token from Razorpay before marking the
     mandate `ACTIVE`.
- If registration needs a small first payment, it is credited to the ledger, not refunded.
- **Changing the cap** creates a new mandate. The old one is cancelled through the API only after the new
  one is confirmed.
- **The user cancels or pauses the mandate in their UPI app:** the webhook updates the state. Uploads past
  the free tier stop, and the current month is collected by payment link (§7.5).

### 7.4 Alerts (what you asked for)

| Trigger | Channel | Sent |
|---|---|---|
| Projected month-end total > cap | push | once per cycle |
| Month-to-date ≥ 80% of cap | push + email | once per cycle |
| **Month-to-date ≥ 100% of cap** ("you've passed your ₹100 limit") | push + email | once per cycle |
| An upload would push the projection over the cap | in-app (upload API returns the projection) | per upload |
| Bill ready: amount and debit date | push + email | per statement |
| Debit succeeded or failed; payment link sent | push + email | per payment |

Each notification is de-duplicated by `Notification.dedupeKey` (e.g. `cap100:{userId}:2026-10`). Reaching
the cap **only notifies; uploads keep working**, as requested. A "stop uploads at my cap" switch can be
added later.

As built (P4): the keys carry the limit too (`limit100:{userId}:2026-10:10000`), so a changed limit
re-arms its alerts. Reaching 80% and 100% in one check sends only the 100% alert (the 80% one is
recorded as superseded, so it can't go out late), and the projection alert stops once the limit is
passed. Notifications are made in the transaction they announce, with an outbox job that sends them;
a channel without credentials, a device or an address is `SKIPPED` and logged, and one that keeps
failing with errors that may pass is retried with backoff for 24 hours, then `FAILED`. FCM tokens
reported dead are cleared from their sessions.

### 7.5 Settlement, excess and failures

After the statement closes:

1. Any positive balance (Play credits) is applied first.
2. **Amount owed ≤ cap:** one mandate debit for the actual amount. The user's bank or UPI app sends the
   pre-debit notice at least 24 h ahead, as RBI rules require. The money lands about 1–2 days later.
3. **Amount owed > cap:** the cap is debited. A **payment link** (UPI/card) goes out for the excess, due in
   7 days, with a "raise my cap" prompt.
4. **No active mandate:** a payment link for the full amount.
5. **A debit fails:** it is retried once after 3 days, then a payment link is sent. The account becomes
   PAST_DUE at the due date.

Each `Payment` row is written before Razorpay is called, keyed by statement + attempt, so a crash or retry
never debits twice. Before a webhook marks a statement paid, the backend re-fetches the payment from
Razorpay (Momentica's verify-with-the-provider pattern). Webhook effects only ever move state forward.

### 7.6 Google Play compliance (must be in place before charging Play users)

Google Play's Payments policy names **data storage services** as something that must use Play's billing.
In India, Play's **user choice billing** lets an app offer its own billing *alongside* Play's.

The app shows Google's choice screen with two options:
- **"Google Play"**: prepaid credit packs (consumables via RevenueCat, house pattern). They are credited to
  the same ledger and used up by statements before the mandate is charged.
- **"UPI AutoPay / card"**: the mandate.

On mandate payments, Google charges its normal service fee minus 4 percentage points (about 11% at Play's
15% tier). Each mandate payment must be reported to Google through the Play Developer API. That means one
integration file (`playExternalTx.ts`) and a reporting job.

Billing only through a website is not a workable alternative: outside this program, the app may not link
or point users to it. Without user choice billing enrollment, the only compliant option is Play credits on
their own.

*Risk to check early:* whether RevenueCat's KMP SDK supports the user-choice screen. If it doesn't, the app
uses Play Billing Library directly for that screen.

### 7.7 Account standing

| Standing | Enters when | Upload | Download | Share links |
|---|---|---|---|---|
| GOOD | default; after any outstanding amount is paid | ✓ (past the free tier only with a mandate or credit) | ✓ | ✓ |
| PAST_DUE | a statement is unpaid at its due date | ✗ | ✓ | ✓ |
| SUSPENDED | PAST_DUE for 15 days | ✗ | ✓ so users can retrieve their data | ✗ |
| DELETION_SCHEDULED | SUSPENDED for 30 days; warnings at T-14, T-7 and T-1 | ✗ | ✗ | ✗ |
| CLOSED | data purged, or the account was deleted | — | — | — |

Paying the outstanding amount returns the account to GOOD from any state before deletion. The window
lengths are constants that the legal pages quote (protocol 12).

### 7.8 GST and invoices

Statements show GST. If BenchBox is GST-registered, it issues tax invoices. The place of supply needs the
user's state, collected at mandate setup. The CGST/SGST vs IGST split is worked out at display time
(Billanta's `MONEY.md`). **Confirm the treatment with a CA before launch.**

### 7.9 Account deletion (required in-app and on the web by Play)

1. A final statement is made for the partial month. It is collected, or waived if it is below the minimum
   debit.
2. The mandate is **cancelled through the Razorpay API**.
3. Blobs are purged through the outbox, and personal data is deleted.
4. Statements and payment records are kept for the legally required period.
5. Unused Play credits are forfeited (stated in the Terms).

`/delete-account` explains all of this (protocol 12).

---

## 8. API surface (`/api/v1` unless marked *root*)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/google {idToken, device}` → access + refresh · `POST /auth/refresh` (rotation; a reused token revokes that session) · `POST /auth/logout` |
| Account | `GET /me` · `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/revoke-others` · `PUT /me/push-token` · `DELETE /me {idToken}` (needs a fresh Google sign-in). `PATCH /me` waits until there is an editable field (the GST state, P5). |
| Tree | `GET /folders/:id/children` (`root` or a UUID; cursor, limit, sort) · `POST /folders {id,parentId,name}` · `GET /nodes/:id` · `PATCH /nodes/:id {name?,parentId?,updatedAt}` · `POST /nodes/:id/trash` · `POST /nodes/:id/restore` · `DELETE /nodes/:id` (purge) · `GET /trash` · `DELETE /trash` · `GET /search?q=` |
| Sync | `GET /sync/changes?cursor&limit` |
| Uploads | `POST /uploads` · `POST /uploads/:id/parts` · `GET /uploads/:id` · `POST /uploads/:id/complete` · `DELETE /uploads/:id` |
| Downloads | `GET /files/:id/download` → `{url, expiresAt}` |
| Sharing | `POST /shares` · `GET /shares` · `DELETE /shares/:id` · *root:* `GET /s/:token`, `GET /s/:token/items`, `GET /s/:token/download[/:fileId]`, `POST /s/:token/report` |
| Billing | `GET /billing/summary` (standing, stored bytes, month-to-date, projection, cap, mandate, balance, outstanding) · `GET /billing/usage?from&to` · `GET /billing/statements[/:id]` · `POST /billing/mandate` · `DELETE /billing/mandate` · `POST /billing/statements/:id/pay` → payment link · `POST /billing/credits/verify {storeTransactionId}` |
| Platform (*root*) | `GET /` (health) · `GET /config` · `GET /privacy` `/terms` `/delete-account` · `POST /webhooks/razorpay` · `POST /webhooks/revenuecat` · `GET /.well-known/assetlinks.json` · `/admin` |

**Contract conventions** (for the protocol 01 contract folder):
- Money is a decimal string of paise.
- Sizes are JSON numbers of bytes.
- IDs for folders, files and uploads are UUIDs generated by the app.
- Timestamps are ISO-8601 UTC. Billing days and months are in IST.
- The sync cursor is an opaque string.

---

## 9. Background jobs (the `worker` service)

| Job | Schedule (IST) | What makes it safe to re-run |
|---|---|---|
| `metering.closeDay` | daily 00:10 | `UsageDay` primary key `(userId, day)`; resumes after the newest closed day (P4) |
| `billing.closeCycle` | 1st of the month, 00:30 | `Statement` unique `(userId, periodStart)`; a missed run catches up later in the month (P4) |
| `billing.settle` | after closeCycle, then hourly | `Payment` unique `(statementId, kind, attempt)` |
| `billing.alerts` | hourly | `Notification.dedupeKey` (P4) |
| `billing.standing` | daily 09:00 | dated, forward-only transitions |
| `payments.reconcile` | daily | re-fetches non-final payments from Razorpay |
| `play.reportExternalTx` | every 15 min | `Payment.reportedToPlayAt` |
| `uploads.expire` | every 15 min | conditional state change, `SKIP LOCKED` (P3) |
| `outbox.drain` | every minute | `FOR UPDATE SKIP LOCKED` + a 5-min lease, retries with backoff (P3) |
| `trash.autoPurge` | daily 03:00 | node state (P2) |
| `sync.compactTombstones` | daily 03:30 | per-user floor (P2) |
| `sessions.purgeExpired` | daily 04:00 | expiry (P2) |
| `storage.reconcile` | daily 05:00 | report-first; deletes only provable garbage (P3) |

Every job takes a Postgres advisory lock to claim its `JobRun` row. A daily job has one row per IST
date; an interval job keeps one row per IST date too, with `attempts` counting the day's runs, and is
logged only when it did something. A missed or failed run is visible and alertable. The nightly DB
backup runs from the host cron, not the worker (§11).

---

## 10. Security and abuse

- **The bucket is private.** The R2 API token is scoped to this one bucket. Keys go in the server `.env`
  and the credentials registry (protocol 00).
- **Presigned URL lifetimes:** upload parts 1 h, downloads 15 min, thumbnails 1 h, share downloads 5 min.
  Object keys never contain file names.
- **No client-declared number is trusted.** Sizes are checked with `HeadObject`, and every price and amount
  is computed on the server.
- **Webhooks:**
  - Razorpay is verified by HMAC-SHA256 of the raw body (`X-Razorpay-Signature`).
  - RevenueCat is verified by its shared secret, compared in constant time.
  - Both are de-duplicated by event id and return 200 for events we ignore.
  - Unknown product ids are rejected and logged, never silently ignored (the AuraPix lesson).
- **Rate limits** (Momentica's limiter) apply to sign-in, upload start, share access and abuse reports.
- **Logs never contain** tokens, presigned URLs or file names.
- **Admin:** access uses `ADMIN_API_KEY` (house pattern). Every money correction is a `LedgerEntry` of type
  `ADJUSTMENT` with a required note.
- **Abuse:**
  - The Terms include an acceptable-use section.
  - Share links have a report flow, an admin takedown, and a per-user switch to disable sharing.
  - Hash-based scanning of shared content is a later option.

---

## 11. Infrastructure, deploy and backups

- **Following protocols 03 and 05:**
  - Compose project `name: benchbox`, with `app` on `127.0.0.1:8094`. Ports 8080 and 8090–8093 are taken;
    re-check on the box.
  - Services: `app`, `worker` (same image, `node dist/worker.js`), and `migrate` under the `tools` profile.
  - A `benchbox` database and role on the host Postgres.
  - An nginx vhost and a certbot certificate for `benchbox.ferbotz.com`.
- **R2:** bucket `benchbox-files` with the APAC location hint, private, with the default lifecycle rule
  that expires unfinished multipart uploads after 7 days (new buckets get it; check it's there). A
  second bucket, `benchbox-files-dev`, with its own token, for `check:r2-live` from a dev machine.
- **Box capacity:** BenchBox would be the **5th app** on the t3.micro (~1 GB RAM). Momentica's `DEPLOY.md`
  says to move to a larger instance at that point. Resize to at least a t3.small before launch. That needs a
  stop/start of the shared box, so it is your call.
- **Backups:** protocol 08 isn't written yet, but BenchBox can't launch without backups. Object keys are
  opaque, so **losing the database would lose every user's file tree**. The plan:
  - a nightly `pg_dump` to a private bucket, kept for 30 days
  - a restore test every month
  - object keys carry the owner and blob ids (`u/{userId}/{blobId}`), so the bucket alone still says
    whose bytes are whose. Names live only in the database: the backups are the recovery path.
    (Writing ids into object metadata, as first planned, would need extra signed headers on every
    upload; the key already has them.)
- **Steps you run** (protocol 02 boundary, plus the new vendors). Claude prepares exact instructions for
  each:
  - Cloudflare account, bucket and scoped token
  - Razorpay KYC, recurring-payments activation and webhook secret
  - Play Console user choice billing enrollment and a service account
  - Firebase project
  - SES domain verification (DNS)
  - box resize

---

## 12. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 Foundations** | Protocol 00 setup: Drive folder, contract folder, docs mirror; the details doc and credentials registry entries are written at first deploy, when there are secrets to record. Scaffold per protocol 04, `/config`, legal pages, health, Docker/compose, `CLAUDE.md`. DNS, vhost, TLS. The R2 bucket is created by you, ready for P3. | `https://benchbox.ferbotz.com` serves health, `/config` and the legal pages. Contract folder bootstrapped. |
| **P1 Accounts** | Database and role on the host Postgres, Prisma and the `migrate` service (moved here from P0 because nothing reads a database before P1). Google sign-in, access + refresh sessions (D1), session list/revoke, push-token registration, account-deletion skeleton. | `check:auth` (pure) and `check:auth-db` (local database) pass: rotation, the lost-response retry window, reuse detection, idle expiry, revoke-others, re-auth for deletion. **Built, checked and deployed 2026-10-01** (Google sign-in configured 2026-10-26). |
| **P2 Tree + sync** | Folders and files metadata, rename/move, trash/restore/purge, search, sync feed, plus the worker (D5) with trash auto-purge, tombstone compaction and expired-session cleanup | `check:tree` (pure) and `check:tree-db` (local database) pass: cycles, name conflicts, restore clashes, `ifSeq`, feed ordering and ties, compaction → resync, auto-purge, concurrency, job claims. **Built, checked and deployed 2026-10-09.** |
| **P3 Data plane** | Upload sessions (single + multipart, resume), complete + verify, thumbnails, downloads, outbox deletes, sweeper, reconciliation, `StorageEvent` choke point | A 5 GB upload survives network drops and an app kill. `check:storage` invariants hold. **Built and checked 2026-10-22** (`check:storage` 13, `check:storage-db` 22: resume, crash recovery, races, purge, the outbox, reconciliation, 20,000-file scale). Live R2 behaviour is `check:r2-live`, run once the dev bucket exists. **Deployed 2026-10-23**; storage turned on 2026-10-26 (`check:r2-live` 5 against the dev bucket). |
| **P4 Metering + statements** | Daily close, PriceBook, month-to-date and projection, monthly statements, FCM + SES, cap alerts | The `check:metering` worked examples match. Re-running a close changes nothing. Alerts fire once per cycle. **Built and checked 2026-10-27** (`check:metering` 18, `check:billing-db` 12: the ₹43.27 example end to end, re-run and racing closes, live = closed numbers, carry-forward, alerts once per month and limit, delivery skips/retries/give-up). Not deployed; push and email wait on their credentials (`docs/DEPLOY.md`). Left for P5: the upload response's projection (§5.1) and the ledger entry (§7.2); download metering awaits a decision (§5.2). |
| **P5 Mandate billing** | Razorpay customer + mandate, webhooks, settlement (≤ cap, excess link, retry), standing state machine, cap change, cancellation, deletion → cancel mandate | Full cycle in Razorpay test mode, including replayed webhooks and a crash between "Payment row written" and "Razorpay called". `check:settlement` passes. |
| **P6 Play compliance** | User choice billing enrollment, Play credit packs via RevenueCat into the ledger, alternative-billing reporting | Credits are used before the mandate. Each mandate payment is reported to Google. |
| **P7 Share links** | Links, public page, App Links, limits, abuse reports, admin takedown | Privacy review signed off. Rate limits verified. |
| **P8 Launch hardening** | Admin panel (users, statements, adjustments, takedowns), backups + restore test, job and webhook alerts, load test, final legal text, store listing URLs | Every item on the protocol 00 "done when" list is checked. |

P7 can run in parallel with P4–P6. Internal testing can start after P3 using the free tier only. Charging
real users needs P5 **and** P6.

---

## 13. Open decisions (suggested defaults)

1. **Price and free tier:** ₹2.50/GB-month + GST above 2 GB free. Seeded as the first `PriceBook` row
   (with the ₹10 minimum of item 5); confirming other numbers is a new row (`docs/DEPLOY.md`).
2. **Cap presets:** ₹100 (default), ₹250, ₹500, ₹1,000, or custom.
3. **Over the cap:** debit the cap and send a payment link for the rest, due in 7 days. The alternative is
   to block uploads at the cap.
4. **Grace windows:** PAST_DUE at the due date → SUSPENDED after 15 days → deletion after 30 more days.
   Also decide whether storage keeps accruing charges while SUSPENDED. Suggested: stop, so the way back
   stays affordable.
5. **Minimum debit:** ₹10. Smaller totals carry into next month.
6. **Business setup before P5 goes live:** legal entity, GST registration, Razorpay recurring activation.
7. **Play side before P6:** credit pack sizes and user choice billing enrollment.
8. **Shared box:** resize the t3.micro or give BenchBox its own instance.
9. **Max file size in v1:** 10 GB, set through `/config`.

---

## 14. Sources

- Cloudflare R2 pricing (2026): https://www.bucketmate.app/blogs/cloudflare-r2-pricing-2026
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- AWS S3 pricing, Mumbai (2026): https://precisiontech.in/cloud/amazon-aws-cloud/aws-pricing/aws-pricing-in-mumbai/
- Google Play Payments policy (data storage named): https://support.google.com/googleplay/android-developer/answer/10281818?hl=en
- Google Play billing changes for India (user choice billing): https://support.google.com/googleplay/android-developer/answer/13306652?hl=en-IN
- Understanding user choice billing: https://support.google.com/googleplay/android-developer/answer/13821247?hl=en
- Razorpay recurring payments for UPI (`max_amount`, `as_presented`): https://razorpay.com/docs/payments/recurring-payments/upi/apis/
