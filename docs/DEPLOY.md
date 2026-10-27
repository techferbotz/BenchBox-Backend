# Deploying BenchBox

BenchBox runs on the shared House of Apps EC2 box (protocols 03 + 05). The standard deploy is protocol 05.
This page covers BenchBox's setup on the box and its project-specific steps.

| | |
|---|---|
| Domain | `benchbox.ferbotz.com` (DNS on Cloudflare, **DNS only** / grey cloud, like the other apps) |
| Box | shared EC2 `i-0ee7ba0922056100d`, **t3.small**, `ap-south-1a`, Elastic IP `13.205.128.80`, 40 GiB gp3 root disk (`vol-0b4bee81a79dd91be`) |
| Checkout | `/opt/apps/benchbox/BenchBox-Backend` |
| Compose project | `benchbox` (`docker-compose.prod.yml`), container `benchbox-app-1` |
| Loopback port | `127.0.0.1:8094` → container `8080` |
| nginx site | `/etc/nginx/sites-available/benchbox` (symlinked into `sites-enabled/`) |
| Repo | `github.com/techferbotz/BenchBox-Backend` (private), branch `master`; the box pulls over SSH with its own `techferbotz` key |

## Status

> **Renamed BrimBox → BenchBox (decided 2026-10-22, switched on the box 2026-10-23).** This page uses
> the new names throughout. Everything dated before 2026-10-23 happened under the old ones:
> `brimbox.ferbotz.com`, Compose project `brimbox`, `/opt/apps/brimbox/BrimBox-Backend`, database and
> role `brimbox`, repo `techferbotz/BrimBox-Backend`. See the
> [rename switch](#rename-switch-brimbox--benchbox-done-2026-10-23) for what was run.

- **2026-10-01 — P0 live** (commit `3cb36e1`): `/`, `/config` and the legal pages. Plain HTTP redirects
  to HTTPS. The current certificate (`benchbox.ferbotz.com`, issued 2026-10-23) expires 2027-01-21 and
  renews automatically (`certbot.timer`; a renewal dry run passed).
- **2026-10-01 — P1 deployed** (commit `06555bd`).
  - **Database:** `benchbox` (owned by role `benchbox`) on the host PostgreSQL 18.6, with migration
    `20261001094719_init_accounts` applied.
  - **Endpoints:** `/api/v1/auth/*` and `/api/v1/me` are live.
  - **Sign-in:** answered 503 until `GOOGLE_CLIENT_ID` was set on 2026-10-26 (Google OAuth client,
    below).
- **2026-10-09 — P2 deployed** (commit `884e2f3`).
  - **Migration:** `20261009153216_tree_sync_jobs`.
  - **Endpoints:** `/api/v1/folders|nodes|trash|search|sync` are live behind sign-in.
  - **Worker:** the new `benchbox-worker-1` container ran its three daily jobs for that day on start
    (all SUCCEEDED).
  - **Disk:** 20 → 19 GB free.
- **2026-10-23 — P3 deployed with the rename switch** (commit `8f1eb8c`). Uploads, downloads,
  thumbnails, metering's storage log, the outbox and reconciliation.
  - **Migration:** `20261022053023_uploads_storage`.
  - **Endpoints:** `/api/v1/uploads` and `/api/v1/files` are live behind sign-in. The file endpoints
    answer `503 STORAGE_NOT_CONFIGURED` until the `R2_*` variables are set.
  - **Worker:** six jobs (two every N minutes); all of that day's runs SUCCEEDED, and reconciliation
    reported "bucket: not checked (storage not configured)".
  - **Disk:** 13 GB free after the builds and removing the three old `brimbox-*` images.
- **2026-10-26 — Google sign-in configured.** `GOOGLE_CLIENT_ID` (the web client id) is in the server
  `.env` and the app container was recreated. A junk idToken now gets `401 INVALID_ID_TOKEN` instead
  of `503`. Only the app's debug key is registered (APP-001); the release key needs its own Android
  client.
- **2026-10-26 — File storage on.** The four `R2_*` values for `benchbox-files` are in the server
  `.env`, and the app and worker were recreated. From inside the app container, R2 answers (an empty
  bucket). Against `benchbox-files-dev`, `check:r2-live` passed 5 of 5 after two fixes it found:
  - its multipart test used a file below the 16 MiB single-PUT limit;
  - R2 re-encodes multipart upload ids on every listing, so `storage.reconcile` would have aborted
    every upload still under way. It now matches uploads by key, and the fake store mimics R2. The
    fix was deployed the same day (commit `c714af5`, box at `56f23a9`; no migration).

  The tokens were pasted into a chat session: roll them when convenient (R2 setup, below).
- **2026-10-27 — P4 built, not deployed** (BE-009): metering's daily close and price book, monthly
  statements, the billing endpoints, and usage alerts by push and email. Deploying it waits on the
  owner's OK ([P4 deploy](#p4-deploy-metering-statements-alerts-runbook-not-run-yet)). Push and email
  stay off, skipped and logged, until their credentials exist ([FCM](#push-fcm-setup-human),
  [SES](#email-ses-setup-human)).

## Who does what

Following protocol 02, Claude runs deploys and migrations over SSH. A human runs anything that widens
access or touches an account. Claude prepares the exact steps for each.

| Step | Who | Status |
|---|---|---|
| Create the private GitHub repo and push | human creates, Claude pushes | done |
| Resize the box to t3.small (stop/start) | human (the auto-mode classifier blocks agents from stopping instances) | done 2026-10-01 |
| Clone on the box, write `.env`, build and start, nginx site | Claude, over SSH | done 2026-10-01 |
| DNS A record `benchbox` → `13.205.128.80`, DNS only (Cloudflare dashboard) | human | done 2026-10-01 |
| certbot for `benchbox.ferbotz.com` | Claude, over SSH | done 2026-10-01 |
| Details doc (protocol 00): `G:\My Drive\BenchBox\BenchBox details.md` | Claude | done 2026-10-01 |
| Postgres role + database, `pg_hba.conf` line, secrets in `.env`, migrate, app (P1) | Claude, over SSH | done 2026-10-01 |
| DB password + `JWT_SECRET` in the details doc (copied box → doc, never displayed) | Claude | done 2026-10-01 |
| Copy the details doc's "Secret values" into the HOA Credentials Registry | human | pending |
| Google OAuth client: consent screen, Android (debug key) + Web clients | human | done 2026-10-26 |
| `GOOGLE_CLIENT_ID` into the server `.env`, recreate the app | Claude, over SSH | done 2026-10-26 |
| P2: migrate, build + start app and worker | Claude, over SSH | done 2026-10-09 |
| Grow the root EBS volume 20 → 40 GiB (`modify-volume`; irreversible) | human | done 2026-10-09 |
| Grow partition + ext4 filesystem into it (`growpart`, `resize2fs`; online) | Claude, over SSH | done 2026-10-09 |
| R2: enable R2 on the Cloudflare account; buckets `benchbox-files` + `benchbox-files-dev`, an Account API token scoped to each (Cloudflare dashboard) | human | done 2026-10-26 |
| R2 values into the details doc's R2 section | Claude, from the owner | done 2026-10-26 |
| R2 values → server `.env` (production bucket) and local `.env` (dev bucket), never displayed | Claude | done 2026-10-26 |
| Roll both R2 tokens (they were pasted into a chat session); new values into the details doc, then Claude swaps them in | human, then Claude | pending |
| Rename: DNS A record `brimbox` renamed to `benchbox` → `13.205.128.80`, DNS only (Cloudflare dashboard); the old name no longer resolves | human | done 2026-10-23 |
| Rename: GitHub repo `BrimBox-Backend` → `BenchBox-Backend` | human | done 2026-10-23 |
| Rename: the credentials registry's entry | — | not needed: the registry never got an entry (last edited 2026-09-23); see the "Secret values" row above |
| Rename: Drive folder, details doc, contract folder; BE-005; protocol 03 | Claude | done 2026-10-23 |
| Google OAuth Android client for the debug key: `com.ferbotz.benchbox` + its SHA-1 (APP-001) | app side, then human | done 2026-10-26 |
| Another Android client for each further key (release, Play app signing), from its `APP-nnn` request | app side, then human | when each SHA-1 arrives |
| Firebase project `benchbox-75a31` (number `339320620607`) with the Android app; `google-services.json` to the app through the contract (BE-007) | human, then Claude | done 2026-10-26 |
| FCM sending credential for the server: a service account with only the FCM role, its JSON key's three fields into the details doc ([Push (FCM) setup](#push-fcm-setup-human)) | human | pending (P4 built) |
| SES: a verified sending domain (DKIM records in Cloudflare), production access, and a send-only IAM user's keys into the details doc ([Email (SES) setup](#email-ses-setup-human)) | human (IAM + DNS + console, protocol 02) | pending (P4 built) |
| P4 deploy: migrate, rebuild app + worker | Claude, over SSH, with the owner's OK | pending |
| `FCM_*` / `SES_*` from the details doc into the server `.env`, never displayed; recreate app + worker | Claude | after each credential exists |
| Rename switch on the box, with the P3 deploy (runbook below) | Claude, over SSH | done 2026-10-23 |
| Old domain: its DNS record was renamed, so no redirect; old nginx site and certificate removed, old images removed | Claude | done 2026-10-23 |

## The box

- **Size:** resized from t3.micro to **t3.small** (2 vCPUs, 2 GB) on 2026-10-01, when BenchBox became the
  fifth app.
  - Before: 309 MB available and 601 MB in swap.
  - After: about 1.2 GB available and no swap.
- **Elastic IP:** `13.205.128.80` is an Elastic IP, so a stop/start keeps the address and no DNS changes.
- **Boot:** every container uses `restart: unless-stopped`, and docker, postgresql and nginx are all
  enabled at boot.
- **Disk:** the root EBS volume is **40 GiB** since 2026-10-09.
  - **Why it was grown:** the old 19 GB filesystem went from 86% full before BenchBox, to 97% after the P1
    build, to **99% (246 MB free)** eight days later.
  - **After the resize:** a 38 GB filesystem, 48% used, 20 GB free.
  - **Where space goes:** every app builds its image on the box, so Docker's build cache and old images
    grow with each deploy (cache went 5.3 → 6.2 GB in those eight days). On 2026-10-09 Docker held
    12.9 GB of images, 7.2 GB of them unused by any container, plus 6.2 GB of build cache (2.2 GB
    reclaimable). Container logs are small. Only BenchBox caps its own logs.
  - **Before every build,** check `df -h /` and `docker system df`.
  - **Pruning** affects every app on the box, so ask first. A periodic
    `docker builder prune --filter until=720h` (cache unused for 30 days) would keep it in check.
  - **Growing it again:** `modify-volume` is human-run and irreversible (EBS volumes can't shrink); then
    `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1` online. The root partition is the
    last one on the disk, so it can always grow.
- **SSH allow-list:** port 22 is open only to the developer machines' public IPs, which are dynamic.
  If SSH times out, compare `curl -s https://checkip.amazonaws.com` with the security group's port-22
  rules (`sg-0b94e51f24b87d4af`). Updating the list is human-run (protocol 02).

## First-time setup (P0, as run on 2026-10-01 under the old names)

```bash
mkdir -p /opt/apps/benchbox && cd /opt/apps/benchbox      # /opt/apps is owned by ubuntu
git clone git@github.com:techferbotz/BenchBox-Backend.git
cd BenchBox-Backend

# Server .env — never committed; owner-only. P0 needs only these:
( umask 077; cat > .env <<'EOF'
PORT=8080
APP_PUBLIC_URL=https://benchbox.ferbotz.com
APP_HOST_PORT=8094
EOF
)

docker compose -f docker-compose.prod.yml up -d --build app
curl -s http://127.0.0.1:8094/        # expect: BenchBox Backend Running
```

The nginx site is `/etc/nginx/sites-available/benchbox`, in the same style as the other apps' sites.
certbot adds the 443 block and the HTTP→HTTPS redirect itself.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name benchbox.ferbotz.com;

    # File bytes go straight to R2 with presigned URLs and never pass through the API,
    # so request bodies stay small JSON.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8094;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/benchbox /etc/nginx/sites-enabled/benchbox
sudo nginx -t && sudo systemctl reload nginx   # never reload on a failed test: it would affect every app
```

Requests sent in the first moments after a reload can still reach the old workers and get nginx's 404.
Re-test after a second before concluding anything is wrong.

## TLS (done 2026-10-01)

The name must resolve to the box before certbot can prove ownership. certbot uses the box's existing
Let's Encrypt account, rewrites `sites-available/benchbox` with the 443 block and the HTTP→HTTPS
redirect, and tests nginx before reloading it.

```bash
nslookup benchbox.ferbotz.com 1.1.1.1                                       # expect 13.205.128.80
sudo certbot --nginx -d benchbox.ferbotz.com --non-interactive --redirect   # on the box
sudo certbot renew --dry-run --cert-name benchbox.ferbotz.com               # renewal check, changes nothing

# verify
curl -s https://benchbox.ferbotz.com/
curl -s https://benchbox.ferbotz.com/config
curl -sI https://benchbox.ferbotz.com/privacy | head -1
```

The three legal URLs are recorded in `BenchBox details.md` (protocols 00/12). They are what goes into the
Play Console.

To test a server block before its DNS exists, pin the name to the IP:
`curl --resolve benchbox.ferbotz.com:80:13.205.128.80 http://benchbox.ferbotz.com/`.

## P1 deploy: database and sign-in (runbook, done 2026-10-01)

Deploying doesn't need the Google OAuth client: until `GOOGLE_CLIENT_ID` is set, sign-in answers 503
and everything else works. From P1 on, every deploy with a schema change follows protocol 05's order:
migrate first, then rebuild the app.

> **Gotcha (bit us on the first P1 deploy).** If you drive these steps from a script piped into
> `ssh … 'bash -s'`, give every docker command `</dev/null` (or use `run -T`). Otherwise
> `docker compose run` reads the REST OF THE SCRIPT as its stdin, and every step after it silently
> never runs. That time, the migration had applied but the app was never rebuilt.

```bash
cd /opt/apps/benchbox/BenchBox-Backend && git pull

# 1. Can BenchBox's docker network reach the host Postgres? Compare its subnet with pg_hba.conf.
docker network inspect benchbox_default -f '{{(index .IPAM.Config 0).Subnet}}'
sudo grep -vE '^\s*(#|$)' /etc/postgresql/*/main/pg_hba.conf

# 2. Role + database. The password is generated here, goes straight into .env, and is never printed.
PW=$(openssl rand -hex 24)
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
CREATE ROLE benchbox LOGIN PASSWORD :'pw';
CREATE DATABASE benchbox OWNER benchbox;
REVOKE CONNECT ON DATABASE benchbox FROM PUBLIC;
SQL
( umask 077; {
  echo "DATABASE_URL=postgresql://benchbox:${PW}@host.docker.internal:5432/benchbox?schema=public"
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "JWT_EXPIRES_IN=1h"
} >> .env ); unset PW

# 3. Migrate FIRST (always --build), then rebuild the app.
docker compose -f docker-compose.prod.yml run --rm --build migrate
docker compose -f docker-compose.prod.yml up -d --build app

# 4. Verify
curl -s https://benchbox.ferbotz.com/api/v1/me          # 401 UNAUTHORIZED
curl -s -X POST -H 'Content-Type: application/json' -d '{"idToken":"x"}' \
  https://benchbox.ferbotz.com/api/v1/auth/google        # 503 until GOOGLE_CLIENT_ID is set
curl -s https://benchbox.ferbotz.com/config              # still 200
```

Record the two new secrets, the database password and `JWT_SECRET`, in `BenchBox details.md` and the HOA
credentials registry. Copy them from the server `.env`; never paste them into chat.

## P2 deploy: file tree, sync feed, worker (runbook, done 2026-10-09)

A schema change (`Node`, `JobRun`, and `User.syncSeq`/`syncFloor`), so migrate first. P2 also adds the
**worker** service, which needs nothing new in `.env`.

```bash
cd /opt/apps/benchbox/BenchBox-Backend && git pull
df -h / && docker system df                               # room for two image builds?
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null

# verify
curl -s https://benchbox.ferbotz.com/api/v1/folders/root/children    # 401 UNAUTHORIZED (route exists)
curl -s https://benchbox.ferbotz.com/api/v1/sync/changes             # 401 UNAUTHORIZED
docker compose -f docker-compose.prod.yml logs --tail=20 worker     # "BenchBox worker started" + today's job runs
sudo -u postgres psql -d benchbox -c 'select name, "periodKey", status, summary from "JobRun" order by name'
```

The worker runs each daily job once per IST day, at or after its time (03:00 / 03:30 / 04:00). Started
later in the day, it runs that day's jobs straight away. A failed run is retried after 15 minutes; the
`JobRun` table shows each run's status and summary.

### Google OAuth client (human, done 2026-10-26)

Done in BenchBox's own Google Cloud project, **BenchBox** (project number `583560195561`), so the
sign-in consent screen says "BenchBox". The web client id is in the server `.env` and in BE-006.

1. **Google Auth Platform** (formerly "OAuth consent screen"): app name **BenchBox**, a support email,
   the privacy and terms URLs (`https://benchbox.ferbotz.com/privacy`, `/terms`), authorised domain
   `ferbotz.com`, audience External. Publish it ("In production"): while it's in testing, only the
   listed test users can sign in. Skip the logo, which would trigger Google's brand verification.
2. **Clients → Create client → Android:** package `com.ferbotz.benchbox` with the debug key's SHA-1
   (APP-001). Each further signing key (release, then Play app signing) gets **another** Android client
   when the app side sends its SHA-1.
3. **Clients → Create client → Web application:** its client id is the **server client id**. It isn't
   secret. It goes in the server `.env` as `GOOGLE_CLIENT_ID=…`, then recreate the container
   (`docker compose -f docker-compose.prod.yml up -d app`), and in the contract: the app passes it to
   Credential Manager.

## Rename switch: BrimBox → BenchBox (done 2026-10-23)

Done once, with the P3 deploy riding along. The owner had already **renamed** the `brimbox` DNS record
to `benchbox`, so the old name stopped resolving and there was nothing to redirect: the old site and
certificate were removed straight away instead of being kept until 2026-12-30.

```bash
# 1. The new domain's site and certificate (the template is in "First-time setup").
nslookup benchbox.ferbotz.com 1.1.1.1                     # 13.205.128.80
sudo ln -s /etc/nginx/sites-available/benchbox /etc/nginx/sites-enabled/benchbox
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d benchbox.ferbotz.com --non-interactive --redirect

# 2. Stop the old stack.
cd /opt/apps/brimbox/BrimBox-Backend && docker compose -f docker-compose.prod.yml -p brimbox down </dev/null

# 3. Database and role. The role's password is SCRAM, so it survived the rename (an MD5 one wouldn't).
sudo -u postgres psql -c 'ALTER DATABASE brimbox RENAME TO benchbox' -c 'ALTER ROLE brimbox RENAME TO benchbox'
#    pg_hba.conf line 138 became "host benchbox benchbox 172.16.0.0/12 scram-sha-256"
#    (backup: pg_hba.conf.bak-20261023-brimbox beside it)
sudo systemctl reload postgresql

# 4. The checkout: new path, renamed remote, and the two .env values that carry the name
#    (DATABASE_URL's user and database, APP_PUBLIC_URL), edited in place with sed, never displayed.
mkdir -p /opt/apps/benchbox && mv /opt/apps/brimbox/BrimBox-Backend /opt/apps/benchbox/BenchBox-Backend
rmdir /opt/apps/brimbox && cd /opt/apps/benchbox/BenchBox-Backend
git remote set-url origin git@github.com:techferbotz/BenchBox-Backend.git && git pull

# 5. Migrate (P3), then start as Compose project benchbox.
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null
docker network inspect benchbox_default -f '{{(index .IPAM.Config 0).Subnet}}'   # 172.22.0.0/16: inside /12

# 6. Verify: health, /config links on the new domain, legal pages, sign-in route, the worker.
curl -s https://benchbox.ferbotz.com/                     # BenchBox Backend Running
curl -s https://benchbox.ferbotz.com/config | grep -o '"privacyPolicy":"[^"]*"'
docker compose -f docker-compose.prod.yml logs --tail=20 worker

# 7. The old domain (it no longer resolves): site and certificate removed.
cp /etc/nginx/sites-available/brimbox ~/nginx-site-brimbox.bak
sudo rm /etc/nginx/sites-enabled/brimbox /etc/nginx/sites-available/brimbox
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name brimbox.ferbotz.com --non-interactive
sudo certbot renew --dry-run --cert-name benchbox.ferbotz.com             # success

# 8. With the owner's OK: the old images (about 2.5 GB).
docker image rm brimbox-app brimbox-worker brimbox-migrate
```

Downtime: from step 2 to step 5, a few minutes. The API had in fact been unreachable since the DNS
record was renamed, until step 1 put the new domain in front of the old stack.

## P3 deploy: uploads and downloads (runbook, done 2026-10-23)

A schema change (`Blob`, `UploadSession`, `StorageEvent`, `OutboxJob`, `User.storedBytes`,
`Node.blobId`/`hasThumbnail`, and an index on `Node.parentId`), so migrate first. Nothing new is
required in `.env`: without the `R2_*` variables the file endpoints answer 503 and the storage jobs
skip.

```bash
cd /opt/apps/benchbox/BenchBox-Backend && git pull
df -h / && docker system df                               # room for two image builds?
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null

# verify
curl -s https://benchbox.ferbotz.com/config | grep -o '"features":{[^}]*}'   # {"uploads":true}
curl -s https://benchbox.ferbotz.com/api/v1/uploads -X POST                  # 401 UNAUTHORIZED (route exists)
docker compose -f docker-compose.prod.yml logs --tail=20 worker             # six jobs listed, two "every N min"
```

**Turning storage on** (done 2026-10-26): Claude appends the four `R2_*` lines to the server `.env`
straight from the details doc, without displaying them, then recreates both services so they read
them: `docker compose -f docker-compose.prod.yml up -d app worker </dev/null`. A partial set fails
the boot on purpose (`R2 is partly configured…`), so check the logs. Then check R2 from inside the
app container, which prints the bucket and a `null` head for a key that doesn't exist:

```bash
docker compose -f docker-compose.prod.yml exec -T app node -e 'const { objectStore: s } = require("./dist/storage/r2Storage");
s.headObject("u/healthcheck").then((h) => console.log(s.bucket, h))' </dev/null
```

`check:r2-live` proves R2 itself from a dev machine against the dev bucket. End-to-end uploads need a
signed-in app.

**Rolling a token:** Cloudflare → R2 → Manage API tokens → the token → Roll. Put the new values in the
details doc, replace the matching `R2_*` lines in the server `.env` (or the local one, for the dev
bucket) without displaying them, and recreate both services.

### R2 setup (human)

In the Cloudflare account that already hosts `ferbotz.com`:

1. **R2 → Purchase/Enable R2** if it isn't on yet. Cloudflare asks for a payment method even for the
   free tier (10 GB-month of storage and the first millions of operations free; downloads always free).
2. **R2 → Create bucket:** name `benchbox-files`, location hint **Asia-Pacific (APAC)**, Standard class.
   Leave public access **off**: no r2.dev URL, no custom domain. Every access is a presigned URL.
3. **The same again for `benchbox-files-dev`**, used only by `check:r2-live` and local testing, so
   production data never meets a test.
4. **Each bucket → Settings → Object lifecycle rules:** check the default rule that expires unfinished
   multipart uploads after **7 days** is there; new buckets get it. Add it if not.
5. **R2 → Manage API tokens → Create Account API token** (not a User API token: an account token
   belongs to the Cloudflare account, so it keeps working if the user who made it changes role or
   leaves), twice:
   - permission **Object Read & Write**, **Apply to specific buckets only** → `benchbox-files`, TTL
     forever;
   - the same for `benchbox-files-dev`.

   Each shows an **Access Key ID** and a **Secret Access Key** once. The **Account ID** is on the R2
   overview page.
6. Put them in the **R2** section of `G:\My Drive\BenchBox\BenchBox details.md` (production and dev
   values in their own blocks, as `R2_ACCOUNT_ID=…` lines) and in the HOA credentials registry. Never
   paste them into chat. Claude moves them from the doc to the server and local `.env` without
   displaying them.

No CORS rule is needed: the Android app isn't a browser. The share pages (P7) will need one only if
they fetch files with JavaScript.

## P4 deploy: metering, statements, alerts (runbook, not run yet)

A schema change (`PriceBook`, `UsageDay`, `Statement`, `BillingAccount`, `Notification`), so migrate
first. The migration also **seeds the price book** with the suggested defaults (₹2.50 per GB-month,
2 GB free, 18% GST, ₹10 minimum, from October 2026): the storage allowance now comes from it. Nothing
new is required in `.env`: without `FCM_*` and `SES_*`, alerts are recorded and their sending skipped.

```bash
cd /opt/apps/benchbox/BenchBox-Backend && git pull
df -h / && docker system df                               # room for two image builds? (firebase-admin adds ~60 MB)
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null

# verify
curl -s https://benchbox.ferbotz.com/api/v1/billing/summary                # 401 UNAUTHORIZED (route exists)
docker compose -f docker-compose.prod.yml logs --tail=30 worker             # nine jobs; "notifications: push not configured…, email not configured…"
```

On start the worker runs `metering.closeDay` (it is past 00:10) and `billing.closeCycle` (a monthly job
is due all month): the close writes every account's days since its first upload, all ₹0 (nobody can
store past the free tier yet), and the statement close finds no month to bill. Then check the
`JobRun` rows: `metering.closeDay`, `billing.closeCycle` and `billing.alerts` SUCCEEDED.

**Turning on push or email** (once its credentials exist): Claude appends the lines to the server
`.env` from the details doc without displaying them, then recreates both services
(`docker compose -f docker-compose.prod.yml up -d app worker </dev/null`; only the worker sends, but
they share the `.env`). A partial set fails the boot on purpose (`FCM is partly configured…`), so check
the logs; the worker's start line then says `push via FCM` / `email via SES`.

### Changing the price

Prices are rows, not code. **Add a row; never edit one that has priced a day** (`UsageDay.priceBookId`
and each statement point at it). `effectiveFrom` must be the 1st of a month (a CHECK refuses anything
else). An increase — a higher price per GB-month or a smaller free allowance — takes effect from the
first month starting at least 30 days after the row is recorded (`createdAt`), whatever its
`effectiveFrom` says, because the Terms promise that notice; announce it to users at the same time. A
decrease can start on any coming 1st. Add the row before its month starts:

```bash
docker compose -f docker-compose.prod.yml exec -T app node -e '
const { PrismaClient } = require("@prisma/client"); const p = new PrismaClient();
p.priceBook.create({ data: { effectiveFrom: new Date("2027-01-01T00:00:00Z"), storagePaisePerGbMonth: 250n,
  freeBytes: 2000000000n, gstBasisPoints: 1800, minimumChargePaise: 1000n, note: "Confirmed by the owner on …" } })
  .then((b) => console.log(b.id, b.effectiveFrom)).finally(() => p.$disconnect())' </dev/null
```

### Push (FCM) setup (human)

In the Google Cloud console of the Firebase project `benchbox-75a31`:

1. **IAM & Admin → Service accounts → Create service account**: `benchbox-push`, with the single role
   **Firebase Cloud Messaging API Admin** (not the default `firebase-adminsdk` account, which can do
   far more).
2. The account → **Keys → Add key → JSON**. A key file downloads.
3. Put its `project_id`, `client_email` and `private_key` in a new **FCM** section of
   `G:\My Drive\BenchBox\BenchBox details.md` as `FCM_PROJECT_ID=…`, `FCM_CLIENT_EMAIL=…` and
   `FCM_PRIVATE_KEY="…"` (the key on one line, its line breaks written `\n`, in double quotes), and in
   the HOA credentials registry. Delete the downloaded file. Never paste the key into chat.

Claude then moves the three lines into the server `.env` as above.

### Email (SES) setup (human)

Protocol 02: identities, IAM and DNS are human-run. In `ap-south-1` (Mumbai):

1. **Pick the From address**: suggested `BenchBox <billing@ferbotz.com>`. Its domain must be verified.
2. **Verify the domain**: SES → Identities → Create identity → Domain `ferbotz.com` (skip if another
   House of Apps project verified it), Easy DKIM, RSA 2048. Add the three DKIM CNAME records it shows in
   the Cloudflare dashboard (DNS only), and wait for "Verified".
3. **Production access**: SES → Account dashboard → Request production access (transactional mail,
   website `https://benchbox.ferbotz.com`, use: "billing alerts and monthly statements to our own
   users"). Until it is granted SES only sends to verified addresses.
4. **A send-only IAM user** (not the box's instance role, which every app on the box shares):

   ```bash
   aws iam create-user --user-name benchbox-ses
   aws iam put-user-policy --user-name benchbox-ses --policy-name benchbox-ses-send --policy-document '{
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "ses:SendEmail",
       "Resource": "arn:aws:ses:ap-south-1:<account id>:identity/ferbotz.com",
       "Condition": { "StringEquals": { "ses:FromAddress": "billing@ferbotz.com" } }
     }]
   }'
   aws iam create-access-key --user-name benchbox-ses
   ```

5. Put `SES_REGION=ap-south-1`, `SES_FROM=BenchBox <billing@ferbotz.com>`, `SES_ACCESS_KEY_ID` and
   `SES_SECRET_ACCESS_KEY` in a new **SES** section of the details doc and in the credentials registry.

Claude then moves the four lines into the server `.env` as above.

## Later phases add

- **P5:** Razorpay credentials.

## Standard deploys

Follow protocol 05 (`G:\My Drive\HOA Protocols\05-deployment-runbook.md`):

```bash
cd /opt/apps/benchbox/BenchBox-Backend && git pull
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null
```

Then verify with the curls above. From P1, a schema change runs the migrate service **first**, always
with `--build`. From P2, rebuild **both** services: they share the image.
