# BenchBox Backend

Backend for **BenchBox**, a pay-as-you-use cloud storage app. Users keep files and folders in the cloud
and pay each month for the storage they actually used: a monthly bill collected through a UPI AutoPay /
card mandate with a limit the user chooses, with Google Play credits alongside. The client is a Kotlin
Multiplatform app, **Android first**, iOS later.

**The design is in [`docs/BACKEND_PLAN.md`](docs/BACKEND_PLAN.md)** — architecture, data model, metering,
billing, and the phased roadmap (§12). Read it before building a phase. **P0 (foundations) has been live
since 2026-10-01. P1 (accounts: Google sign-in, device sessions, account deletion), P2 (file tree,
trash, search, sync feed, worker) and P3 (uploads, downloads, thumbnails, the storage log, the outbox,
reconciliation; deployed 2026-10-23) are live at `https://benchbox.ferbotz.com`. Google sign-in is
configured since 2026-10-26 (only the app's debug key is registered so far; release-key SHA-1s arrive
as APP requests). File storage is on since 2026-10-26 (R2 bucket `benchbox-files`). Next: P4
(metering, statements, FCM + SES).** Deploy facts: `docs/DEPLOY.md`.

**Renamed from BrimBox on 2026-10-22; the box switched over on 2026-10-23.** Everything — code, docs,
domain, Compose project, checkout path, database and role, GitHub repo, Drive folders — uses BenchBox /
`benchbox`. Commits before 2026-10-22 say BrimBox.

## House of Apps protocols

This project follows the shared HOA playbook in `G:\My Drive\HOA Protocols\`. Read `README.md` there
first; it indexes the rest. The ones that bind this repo:

- **00 — New project setup**: Drive folder `G:\My Drive\BenchBox\`, details doc, credentials registry,
  docs mirror, contract folder.
- **01 — Server ↔ client contract**: `G:\My Drive\BenchBox\BenchBox-Contract\` is the **only** channel to
  the app. Write only in `backend/`; read `app/REQUESTS.md` past the watermark in `backend/applied.md`;
  log every app-observable change as a `BE-nnn` entry in `backend/CHANGELOG.md`. **Never read or clone
  the app's repository.** `backend/API.md` mirrors `docs/FRONTEND_API.md` — refresh it in the same change.
- **02 — Claude ↔ AWS access**: security-group edits, IAM changes and public-bucket policies are
  **human-run**, never agent-run. Prepare the exact command and hand it over. The same goes for the
  Cloudflare dashboard (DNS, R2 bucket + token) and the Razorpay / Play Console accounts.
- **03 — AWS infrastructure**: shared EC2 box, host Postgres (database + role per project), loopback-only
  container port, nginx vhost + certbot.
- **04 — Tech stack & conventions**: the stack below. Deviate only with a written reason (next section).
- **05 — Deployment runbook**: migrate **before** rebuilding the app, and always pass `--build` to the
  migrate service or it silently runs a stale image.
- **10 — Remote config** (`GET /config`) and **12 — Legal pages** (`/privacy`, `/terms`,
  `/delete-account`): present from day one.

### Deviations from protocol 04, and why

Full reasons in `docs/BACKEND_PLAN.md` §2.

- **D1 — Tokens expire.** 1-hour access JWT + a rotating refresh token per device (Billanta's pattern),
  not the house's permanent token. Protocol 04 itself says to reinstate expiry for payment/sensitive
  surfaces: BenchBox holds private files and a mandate on the user's bank account. (Lands in P1.)
- **D2 — Files never touch this server.** Cloudflare R2, private bucket, presigned direct upload/download,
  multipart for large files, originals stored byte-exact. No multer, no sharp in the request path, no
  public-read objects.
- **D3 — The app makes thumbnails** and uploads them with the file; the shared box has no CPU/RAM to spare.
- **D4 — No client clocks in sync.** The cursor is a server-assigned per-user sequence, and changes
  apply in arrival order, with an optional `ifSeq` precondition (409 `NODE_CHANGED`) instead of
  protocol 04's last-write-wins on the client's `updatedAt`. Client UUIDs (idempotent by id) and
  tombstones stay as in protocol 04.
- **D5 — A long-running `worker` service** (same image, `node dist/worker.js`) runs daily jobs under an
  advisory lock with a `JobRun` row per job and IST day, instead of host-crontab scripts. Since P2:
  trash auto-purge, tombstone compaction, expired-session cleanup. Since P3: the outbox drain (every
  minute), upload expiry (every 15 min), storage reconciliation (daily).
- **D6 — Razorpay recurring payments** (the mandate) plus RevenueCat (Play credits).
- **D7 — FCM + Amazon SES** for billing alerts, each behind one file.
- **Smaller ones:** the failure envelope always carries `code` (allowed by `code?`).

## Commands

```bash
npm run dev               # ts-node-dev on http://localhost:8080
npm run dev:worker        # the scheduled-jobs worker, locally
npm run typecheck         # tsc --noEmit — run after every change
npm run build             # tsc -> dist/  (run npm run prisma:generate after schema changes)
npm run check:all         # pure fixture scripts: check:config, check:legal, check:auth, check:tree, check:storage
npm run check:auth-db     # sign-in/session flows against a LOCAL database (refuses any other host)
npm run check:tree-db     # tree, trash, sync, compaction, jobs against a LOCAL database
npm run check:storage-db  # uploads, purges, outbox, reconcile against a LOCAL database + in-memory R2
npm run check:r2-live     # real R2 behaviour against the DEV bucket (refuses a non-dev bucket)
npm run prisma:migrate    # create/apply a migration locally (prisma migrate dev)
```

Local env: copy `.env.example` to `.env`. Variables are read **only** in `src/config/env.ts`:

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (8080) | Listen port; 8080 inside the container |
| `APP_PUBLIC_URL` | yes | Public origin, e.g. `https://benchbox.ferbotz.com` — legal links in `/config` are built from it |
| `DATABASE_URL` | yes | PostgreSQL; production reaches the host Postgres as `host.docker.internal` |
| `JWT_SECRET` | yes (≥ 32 chars) | Signs access tokens. Rotating it does **not** sign users out (apps refresh) |
| `JWT_EXPIRES_IN` | no (`1h`) | Access-token lifetime, 1m–24h; `never` is refused (D1) |
| `GOOGLE_CLIENT_ID` | no | OAuth **web** client id(s), comma-separated; unset → sign-in answers 503 |
| `REMOTE_CONFIG_OVERRIDES` | no | JSON patch over the default `/config` document; a bad patch fails startup |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | all or none | Cloudflare R2. None → file endpoints answer 503 and storage jobs skip; a partial set fails startup. Production: `benchbox-files`; local: `benchbox-files-dev` |
| `R2_ENDPOINT` | no | Override the S3 endpoint (a local S3-compatible stand-in); production leaves it unset |
| `APP_HOST_PORT` | prod only | Loopback port compose publishes on the box (8094) |

## Directory map

```
prisma/schema.prisma            User, Session, Node, Blob, UploadSession, StorageEvent, OutboxJob,
                                JobRun (+ migrations/)
src/
  app.ts                        express app: middleware, root routes, 404, error handler, listen
  worker.ts                     the worker process: scheduled jobs (D5)
  config/env.ts                 the only reader of process.env (fail fast)
  prisma/client.ts, sql.ts      the Prisma singleton; raw-SQL helpers (utc, lockUserRow) — repositories only
  storage/objectStore.ts        the ObjectStore interface services depend on
  storage/r2Storage.ts          sole importer of the AWS SDK (R2: presign, multipart, head, delete, list)
  common/                       deepMerge, duration, validation, errors/, response/,
                                middleware/ (auth, rateLimit, device, requestLogger),
                                utils/tokens.ts (sole importer of jsonwebtoken)
  integrations/googleVerifier.ts  sole importer of google-auth-library
  modules/
    auth/                       /api/v1/auth: sign-in, refresh (rotation), logout; Session repository;
                                auth.rules.ts (pure decisions) + auth.policy.ts (numbers)
    account/                    /api/v1/me: profile, devices, push token, deletion; User repository
    nodes/                      /api/v1/folders|nodes|trash|search: the tree; UserTx (locked reads +
                                storage tables) and TreeTx (adds node writes with a syncSeq);
                                nodes.rules.ts (names, cursors) + nodes.policy.ts (numbers)
    files/                      /api/v1/uploads + /api/v1/files: uploads, downloads, thumbnails,
                                reconciliation; Blob + UploadSession repositories; files.rules.ts
                                (part plan, keys, media types) + files.policy.ts (sizes, lifetimes)
    metering/                   MeteringTx.recordStorageChange (THE choke point), usage, accounting
    outbox/                     after-commit work, retried until done (R2 deletes); outbox.jobs.ts (pure)
    sync/                       /api/v1/sync/changes: the change feed; tombstone compaction
    jobs/                       scheduler (daily + interval jobs), JobRun repository, jobs.ts (the job
                                list), jobs.schedule.ts
    remoteConfig/               GET /config (protocol 10)
    legal/                      /privacy /terms /delete-account (protocol 12) + public-promise constants
  scripts/check-*.ts            fixture checks (the *-db ones need a local database);
                                scripts/support/fakeObjectStore.ts is the in-memory R2
  types/express.d.ts            req.userId / req.sessionId / req.deviceId
docs/                           BACKEND_PLAN.md, FRONTEND_API.md, REMOTE_CONFIG.md, DEPLOY.md,
                                UI_DESIGN_PROMPT.md (the Claude Design brief for the app's UI; keep
                                it in step with features)
```

Feature modules follow Billanta/Curiously: `modules/<f>/<f>.routes.ts` + `controller/ service/
repository/ dto/`. External SDKs each sit behind exactly one file (`storage/r2Storage.ts`,
`integrations/razorpay.ts`, …).

## Conventions

- Envelope: `{ success: true, data }` / `{ success: false, code, message }`. Throw `AppError`
  subclasses; never write an error response by hand. Express 5 forwards rejected promises to the
  error handler, so no `asyncHandler`.
- Routes: app API under `/api/v1`; `/`, `/config`, the legal pages, share pages (`/s/:token`),
  `/webhooks/*` and `/admin` at the root.
- Layering: route → controller → service → repository; **Prisma only in repositories**.
- Ownership scoped by `userId` on every query; someone else's row is a **404, never a 403**.
- **Auth:** `requireAuth` verifies the access token AND checks its session row on every request, so
  signing a device out is immediate. `GET /config` uses `optionalAuth`, which checks the signature only
  and never touches the database (protocol 10). Services take their Google verifier, token signer and
  clock as constructor deps — that is how `check:auth-db` fakes Google without a test switch in
  production code. Re-auth failures on destructive actions are 403s (a 401 would trigger the app's
  refresh flow).
- **Tree writes** go through `treeRepository.inUserTransaction`. It takes the user's row lock and the
  next `syncSeq` first, which serialises a user's tree changes and makes sibling-name uniqueness
  race-free. Every node a transaction touches gets that one seq, and the feed orders by (syncSeq, id).
  Invariant: an active node's ancestors are all active.
- **Money** (from P4): integer paise in `BigInt`, decimal strings on the wire, `decimal.js` half-up, all
  arithmetic in one `money.ts`. Metering keeps exact charges in micro-paise; statements round once.
- **Every change to stored bytes goes through `MeteringTx.recordStorageChange()`** in the same
  transaction as the metadata change: +bytes at upload completion, −bytes through
  `TreeTx.releaseContent` (purge, replace) and account deletion. Never write `User.storedBytes`
  anywhere else. Bills (P4) are computed from the append-only `StorageEvent` log.
- **R2 deletions go through the outbox**, queued in the transaction that makes them necessary, and
  drained by the worker every minute. A request never deletes from R2 inline.
- **Storage calls in a request** go through `storageCall()` (an R2 failure is a 503
  `STORAGE_UNAVAILABLE`, not a 500) after `requireStore()` (503 `STORAGE_NOT_CONFIGURED`). Services take
  their `ObjectStore` as a constructor dep, like the Google verifier. Never log a presigned URL.
- Remote config is **additive-only**; numbers the server enforces are imported into the defaults, never
  retyped.
- Legal pages: **only claim what the code does**. When data handling changes, change
  `modules/legal/legal.view.ts` in the same commit. Public promises (retention days, billing windows) are
  constants there until their enforcing module lands, then move to it and are imported back.

## Gotchas

- Migrations NEVER run on container start — the discrete `migrate` compose service runs them, before
  the app is rebuilt, always with `--build` (protocol 05).
- Scripts sent over `ssh … 'bash -s' <<EOF`: give every docker command `</dev/null`. Otherwise
  `docker compose run` swallows the rest of the script as stdin and the later steps silently never run.
- Prisma is pinned to v6 (v7 drops `url = env("DATABASE_URL")` and needs a driver adapter).
- Prisma's `contains` / `startsWith` do NOT escape LIKE wildcards: wrap user text in `escapeLike()`.
- Deploys from P2 on rebuild both services: `up -d --build app worker` (after the migrate step).
- R2 multipart: every part except the last must be the same size; R2 has no presigned POST. Always
  verify uploaded sizes with `HeadObject` — never bill a client-declared size.
- AWS SDK ≥ 3.729 adds CRC32 checksums by default; the S3 client runs with
  `requestChecksumCalculation: "WHEN_REQUIRED"`, or checksum parameters land in presigned URLs and the
  app's plain PUTs fail. `check:storage` asserts the URL shape.
- Presigned URLs can't be revoked: cleanup of a cancelled upload waits `UPLOAD_CLEANUP_DELAY_SECONDS`
  so a PUT already under way lands before the delete.
- R2 lists a fresh encoding of a multipart upload id every time (ListMultipartUploads), and every
  encoding works for ListParts and abort. Use upload ids, never compare them: match listed uploads to
  sessions by object key (`reconcile.service.ts`). The fake store does the same; `check:r2-live` pins
  it against the dev bucket.
- Don't walk the tree with a recursive CTE join: when one huge folder dominates the statistics, the
  planner scans the whole `Node` table once per frontier row (a 70,000-file folder took minutes).
  `TreeTx.subtreeIds` goes level by level on the `parentId` index; check:storage-db pins 20,000 files.
- The request logger prints URLs: redact share tokens (`/s/:token`) before P7 ships.
- The shared box (t3.small, 40 GiB disk since 2026-10-09) runs five apps plus Postgres. Every app's
  on-box builds grow Docker's cache, so check `df -h /` before an image build. Never prune Docker
  without asking: the unused images may be other apps' rollback copies (`docs/DEPLOY.md` § The box).
- SSH timing out usually means the dev machine's public IP changed: port 22 only allows listed IPs. The
  fix (a security-group edit) is human-run; `docs/DEPLOY.md` § The box has the check.
