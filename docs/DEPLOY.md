# Deploying BrimBox

BrimBox runs on the shared House of Apps EC2 box (protocols 03 + 05). The standard deploy is protocol 05.
This page covers BrimBox's setup on the box and its project-specific steps.

| | |
|---|---|
| Domain | `brimbox.ferbotz.com` (DNS on Cloudflare, **DNS only** / grey cloud, like the other apps) |
| Box | shared EC2 `i-0ee7ba0922056100d`, **t3.small**, `ap-south-1a`, Elastic IP `13.205.128.80`, 40 GiB gp3 root disk (`vol-0b4bee81a79dd91be`) |
| Checkout | `/opt/apps/brimbox/BrimBox-Backend` |
| Compose project | `brimbox` (`docker-compose.prod.yml`), container `brimbox-app-1` |
| Loopback port | `127.0.0.1:8094` → container `8080` |
| nginx site | `/etc/nginx/sites-available/brimbox` (symlinked into `sites-enabled/`) |
| Repo | `github.com/techferbotz/BrimBox-Backend` (private), branch `master`; the box pulls over SSH with its own `techferbotz` key |

## Status

- **2026-10-01 — P0 live at `https://brimbox.ferbotz.com`** (commit `3cb36e1`): `/`, `/config` and the
  legal pages. Plain HTTP redirects to HTTPS. The Let's Encrypt certificate expires 2026-12-30 and renews
  automatically (`certbot.timer`; a renewal dry run passed).
- **2026-10-01 — P1 deployed** (commit `06555bd`).
  - **Database:** `brimbox` (owned by role `brimbox`) on the host PostgreSQL 18.6, with migration
    `20261001094719_init_accounts` applied.
  - **Endpoints:** `/api/v1/auth/*` and `/api/v1/me` are live.
  - **Sign-in:** answers 503 until `GOOGLE_CLIENT_ID` is set (Google OAuth client, below).
- **2026-10-09 — P2 deployed** (commit `884e2f3`).
  - **Migration:** `20261009153216_tree_sync_jobs`.
  - **Endpoints:** `/api/v1/folders|nodes|trash|search|sync` are live behind sign-in.
  - **Worker:** the new `brimbox-worker-1` container ran its three daily jobs for that day on start
    (all SUCCEEDED).
  - **Disk:** 20 → 19 GB free.
- **2026-10-22 — P3 built and checked locally, not yet deployed.** Uploads, downloads, thumbnails,
  metering's storage log, the outbox and reconciliation. It can deploy before R2 exists: the file
  endpoints answer `503 STORAGE_NOT_CONFIGURED` until the `R2_*` variables are set.

## Who does what

Following protocol 02, Claude runs deploys and migrations over SSH. A human runs anything that widens
access or touches an account. Claude prepares the exact steps for each.

| Step | Who | Status |
|---|---|---|
| Create the private GitHub repo and push | human creates, Claude pushes | done |
| Resize the box to t3.small (stop/start) | human (the auto-mode classifier blocks agents from stopping instances) | done 2026-10-01 |
| Clone on the box, write `.env`, build and start, nginx site | Claude, over SSH | done 2026-10-01 |
| DNS A record `brimbox` → `13.205.128.80`, DNS only (Cloudflare dashboard) | human | done 2026-10-01 |
| certbot for `brimbox.ferbotz.com` | Claude, over SSH | done 2026-10-01 |
| Details doc (protocol 00): `G:\My Drive\BrimBox\BrimBox details.md` | Claude | done 2026-10-01 |
| Postgres role + database, `pg_hba.conf` line, secrets in `.env`, migrate, app (P1) | Claude, over SSH | done 2026-10-01 |
| DB password + `JWT_SECRET` in the details doc (copied box → doc, never displayed) | Claude | done 2026-10-01 |
| Copy the details doc's "Secret values" into the HOA Credentials Registry | human | pending |
| Google OAuth client: consent screen, Android + Web clients | human | pending |
| P2: migrate, build + start app and worker | Claude, over SSH | done 2026-10-09 |
| Grow the root EBS volume 20 → 40 GiB (`modify-volume`; irreversible) | human | done 2026-10-09 |
| Grow partition + ext4 filesystem into it (`growpart`, `resize2fs`; online) | Claude, over SSH | done 2026-10-09 |
| R2: enable R2 on the Cloudflare account; buckets `brimbox-files` + `brimbox-files-dev`, a token scoped to each (Cloudflare dashboard) | human | pending |
| R2 values into the details doc's R2 section | human | pending |
| R2 values → server `.env` (production bucket) and local `.env` (dev bucket), never displayed | Claude | after the above |
| P3: migrate, build + start app and worker | Claude, over SSH | pending |

## The box

- **Size:** resized from t3.micro to **t3.small** (2 vCPUs, 2 GB) on 2026-10-01, when BrimBox became the
  fifth app.
  - Before: 309 MB available and 601 MB in swap.
  - After: about 1.2 GB available and no swap.
- **Elastic IP:** `13.205.128.80` is an Elastic IP, so a stop/start keeps the address and no DNS changes.
- **Boot:** every container uses `restart: unless-stopped`, and docker, postgresql and nginx are all
  enabled at boot.
- **Disk:** the root EBS volume is **40 GiB** since 2026-10-09.
  - **Why it was grown:** the old 19 GB filesystem went from 86% full before BrimBox, to 97% after the P1
    build, to **99% (246 MB free)** eight days later.
  - **After the resize:** a 38 GB filesystem, 48% used, 20 GB free.
  - **Where space goes:** every app builds its image on the box, so Docker's build cache and old images
    grow with each deploy (cache went 5.3 → 6.2 GB in those eight days). On 2026-10-09 Docker held
    12.9 GB of images, 7.2 GB of them unused by any container, plus 6.2 GB of build cache (2.2 GB
    reclaimable). Container logs are small. Only BrimBox caps its own logs.
  - **Before every build,** check `df -h /` and `docker system df`.
  - **Pruning** affects every app on the box, so ask first. A periodic
    `docker builder prune --filter until=720h` (cache unused for 30 days) would keep it in check.
  - **Growing it again:** `modify-volume` is human-run and irreversible (EBS volumes can't shrink); then
    `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1` online. The root partition is the
    last one on the disk, so it can always grow.
- **SSH allow-list:** port 22 is open only to the developer machines' public IPs, which are dynamic.
  If SSH times out, compare `curl -s https://checkip.amazonaws.com` with the security group's port-22
  rules (`sg-0b94e51f24b87d4af`). Updating the list is human-run (protocol 02).

## First-time setup (P0, as run on 2026-10-01)

```bash
mkdir -p /opt/apps/brimbox && cd /opt/apps/brimbox      # /opt/apps is owned by ubuntu
git clone git@github.com:techferbotz/BrimBox-Backend.git
cd BrimBox-Backend

# Server .env — never committed; owner-only. P0 needs only these:
( umask 077; cat > .env <<'EOF'
PORT=8080
APP_PUBLIC_URL=https://brimbox.ferbotz.com
APP_HOST_PORT=8094
EOF
)

docker compose -f docker-compose.prod.yml up -d --build app
curl -s http://127.0.0.1:8094/        # expect: BrimBox Backend Running
```

The nginx site is `/etc/nginx/sites-available/brimbox`, in the same style as the other apps' sites.
certbot adds the 443 block and the HTTP→HTTPS redirect itself.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name brimbox.ferbotz.com;

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
sudo ln -s /etc/nginx/sites-available/brimbox /etc/nginx/sites-enabled/brimbox
sudo nginx -t && sudo systemctl reload nginx   # never reload on a failed test: it would affect every app
```

Requests sent in the first moments after a reload can still reach the old workers and get nginx's 404.
Re-test after a second before concluding anything is wrong.

## TLS (done 2026-10-01)

The name must resolve to the box before certbot can prove ownership. certbot uses the box's existing
Let's Encrypt account, rewrites `sites-available/brimbox` with the 443 block and the HTTP→HTTPS
redirect, and tests nginx before reloading it.

```bash
nslookup brimbox.ferbotz.com 1.1.1.1                                       # expect 13.205.128.80
sudo certbot --nginx -d brimbox.ferbotz.com --non-interactive --redirect   # on the box
sudo certbot renew --dry-run --cert-name brimbox.ferbotz.com               # renewal check, changes nothing

# verify
curl -s https://brimbox.ferbotz.com/
curl -s https://brimbox.ferbotz.com/config
curl -sI https://brimbox.ferbotz.com/privacy | head -1
```

The three legal URLs are recorded in `BrimBox details.md` (protocols 00/12). They are what goes into the
Play Console.

To test a server block before its DNS exists, pin the name to the IP:
`curl --resolve brimbox.ferbotz.com:80:13.205.128.80 http://brimbox.ferbotz.com/`.

## P1 deploy: database and sign-in (runbook, done 2026-10-01)

Deploying doesn't need the Google OAuth client: until `GOOGLE_CLIENT_ID` is set, sign-in answers 503
and everything else works. From P1 on, every deploy with a schema change follows protocol 05's order:
migrate first, then rebuild the app.

> **Gotcha (bit us on the first P1 deploy).** If you drive these steps from a script piped into
> `ssh … 'bash -s'`, give every docker command `</dev/null` (or use `run -T`). Otherwise
> `docker compose run` reads the REST OF THE SCRIPT as its stdin, and every step after it silently
> never runs. That time, the migration had applied but the app was never rebuilt.

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull

# 1. Can BrimBox's docker network reach the host Postgres? Compare its subnet with pg_hba.conf.
docker network inspect brimbox_default -f '{{(index .IPAM.Config 0).Subnet}}'
sudo grep -vE '^\s*(#|$)' /etc/postgresql/*/main/pg_hba.conf

# 2. Role + database. The password is generated here, goes straight into .env, and is never printed.
PW=$(openssl rand -hex 24)
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
CREATE ROLE brimbox LOGIN PASSWORD :'pw';
CREATE DATABASE brimbox OWNER brimbox;
REVOKE CONNECT ON DATABASE brimbox FROM PUBLIC;
SQL
( umask 077; {
  echo "DATABASE_URL=postgresql://brimbox:${PW}@host.docker.internal:5432/brimbox?schema=public"
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "JWT_EXPIRES_IN=1h"
} >> .env ); unset PW

# 3. Migrate FIRST (always --build), then rebuild the app.
docker compose -f docker-compose.prod.yml run --rm --build migrate
docker compose -f docker-compose.prod.yml up -d --build app

# 4. Verify
curl -s https://brimbox.ferbotz.com/api/v1/me          # 401 UNAUTHORIZED
curl -s -X POST -H 'Content-Type: application/json' -d '{"idToken":"x"}' \
  https://brimbox.ferbotz.com/api/v1/auth/google        # 503 until GOOGLE_CLIENT_ID is set
curl -s https://brimbox.ferbotz.com/config              # still 200
```

Record the two new secrets, the database password and `JWT_SECRET`, in `BrimBox details.md` and the HOA
credentials registry. Copy them from the server `.env`; never paste them into chat.

## P2 deploy: file tree, sync feed, worker (runbook, done 2026-10-09)

A schema change (`Node`, `JobRun`, and `User.syncSeq`/`syncFloor`), so migrate first. P2 also adds the
**worker** service, which needs nothing new in `.env`.

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull
df -h / && docker system df                               # room for two image builds?
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null

# verify
curl -s https://brimbox.ferbotz.com/api/v1/folders/root/children    # 401 UNAUTHORIZED (route exists)
curl -s https://brimbox.ferbotz.com/api/v1/sync/changes             # 401 UNAUTHORIZED
docker compose -f docker-compose.prod.yml logs --tail=20 worker     # "BrimBox worker started" + today's job runs
sudo -u postgres psql -d brimbox -c 'select name, "periodKey", status, summary from "JobRun" order by name'
```

The worker runs each daily job once per IST day, at or after its time (03:00 / 03:30 / 04:00). Started
later in the day, it runs that day's jobs straight away. A failed run is retried after 15 minutes; the
`JobRun` table shows each run's status and summary.

### Google OAuth client (human, for sign-in)

Use a Google Cloud project of BrimBox's own, so the sign-in consent screen says "BrimBox":

1. **OAuth consent screen:** app name **BrimBox**, a support email, and the privacy and terms URLs
   (`https://brimbox.ferbotz.com/privacy`, `/terms`).
2. **Credentials → Create OAuth client → Android:** the app's package name, plus the SHA-1 fingerprints
   of its debug and release signing keys (the app side supplies these).
3. **Credentials → Create OAuth client → Web application:** its client id is the **server client id**.
   It isn't secret. Put it in the server `.env` as `GOOGLE_CLIENT_ID=…` and recreate the container
   (`docker compose -f docker-compose.prod.yml up -d app`). Also publish it in the contract folder: the
   app passes it to Credential Manager.

## P3 deploy: uploads and downloads (runbook)

A schema change (`Blob`, `UploadSession`, `StorageEvent`, `OutboxJob`, `User.storedBytes`,
`Node.blobId`/`hasThumbnail`, and an index on `Node.parentId`), so migrate first. Nothing new is
required in `.env`: without the `R2_*` variables the file endpoints answer 503 and the storage jobs
skip.

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull
df -h / && docker system df                               # room for two image builds?
docker compose -f docker-compose.prod.yml run --rm --build migrate </dev/null
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null

# verify
curl -s https://brimbox.ferbotz.com/config | grep -o '"features":{[^}]*}'   # {"uploads":true}
curl -s https://brimbox.ferbotz.com/api/v1/uploads -X POST                  # 401 UNAUTHORIZED (route exists)
docker compose -f docker-compose.prod.yml logs --tail=20 worker             # six jobs listed, two "every N min"
```

**Turning storage on** (once the R2 values are in the details doc): Claude appends the four `R2_*`
lines to the server `.env` straight from the doc, without displaying them, then recreates both
services so they read them: `docker compose -f docker-compose.prod.yml up -d app worker </dev/null`.
A partial set fails the boot on purpose (`R2 is partly configured…`), so check the logs. End-to-end
uploads can only be tried once sign-in works (the Google OAuth client); before that, `check:r2-live`
proves R2 itself from a dev machine against the dev bucket.

### R2 setup (human)

In the Cloudflare account that already hosts `ferbotz.com`:

1. **R2 → Purchase/Enable R2** if it isn't on yet. Cloudflare asks for a payment method even for the
   free tier (10 GB-month of storage and the first millions of operations free; downloads always free).
2. **R2 → Create bucket:** name `brimbox-files`, location hint **Asia-Pacific (APAC)**, Standard class.
   Leave public access **off**: no r2.dev URL, no custom domain. Every access is a presigned URL.
3. **The same again for `brimbox-files-dev`**, used only by `check:r2-live` and local testing, so
   production data never meets a test.
4. **Each bucket → Settings → Object lifecycle rules:** check the default rule that expires unfinished
   multipart uploads after **7 days** is there; new buckets get it. Add it if not.
5. **R2 → Manage API tokens → Create API token**, twice:
   - permission **Object Read & Write**, **Apply to specific buckets only** → `brimbox-files`, TTL
     forever;
   - the same for `brimbox-files-dev`.

   Each shows an **Access Key ID** and a **Secret Access Key** once. The **Account ID** is on the R2
   overview page.
6. Put them in the **R2** section of `G:\My Drive\BrimBox\BrimBox details.md` (production and dev
   values in their own blocks, as `R2_ACCOUNT_ID=…` lines) and in the HOA credentials registry. Never
   paste them into chat. Claude moves them from the doc to the server and local `.env` without
   displaying them.

No CORS rule is needed: the Android app isn't a browser. The share pages (P7) will need one only if
they fetch files with JavaScript.

## Later phases add

- **P4/P5:** FCM, SES and Razorpay credentials.

## Standard deploys

Follow protocol 05 (`G:\My Drive\HOA Protocols\05-deployment-runbook.md`):

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull
docker compose -f docker-compose.prod.yml up -d --build app worker </dev/null
```

Then verify with the curls above. From P1, a schema change runs the migrate service **first**, always
with `--build`. From P2, rebuild **both** services: they share the image.
