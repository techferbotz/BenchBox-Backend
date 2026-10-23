<!--
  Reference doc — the current contract the BenchBox app builds against.
  Source of truth: the backend repo's docs/FRONTEND_API.md. Mirrored to
  BenchBox-Contract/backend/API.md whenever a CHANGELOG entry says this file moved.
  Last refreshed: 2026-10-23 (BE-005).
-->

# BenchBox — Frontend (Client) API

Everything the app needs to build its data layer. Examples are JSON and stack-agnostic.

- **Base URL:** `https://benchbox.ferbotz.com`. **Not live yet:** until a CHANGELOG entry announces the
  switch, the server answers only at `https://brimbox.ferbotz.com` (the project's old name). Keep the
  base URL in one build setting so the switch is a one-line change; after it, the old domain redirects
  until 2026-12-30.
- **API prefix:** app endpoints live under **`/api/v1`** (§4 onwards). These are unversioned and fixed
  across House of Apps backends: `GET /` (health), `GET /config`, and the legal pages.
- **Content type:** `application/json` for request bodies. File bytes are never sent to this API
  (see §2).

---

## 1. Global conventions

**Success envelope** — the payload is always under `data`:

```json
{ "success": true, "data": { } }
```

**Error envelope** — flat, and `code` is **always present**. Branch on `code` (a stable string), and
show `message` only if you have nothing better:

```json
{ "success": false, "code": "NOT_FOUND", "message": "Route not found: GET /nope" }
```

| code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | The request failed validation |
| `INVALID_JSON` | 400 | The body isn't valid JSON |
| `UNAUTHORIZED` | 401 | No access token on a protected call → refresh (§4) |
| `INVALID_TOKEN` | 401 | Access token expired, invalid, or its device was signed out → refresh (§4) |
| `FORBIDDEN` | 403 | Signed in, but not allowed to do this |
| `NOT_FOUND` | 404 | No such route, or the resource doesn't exist / isn't yours |
| `INVALID_CURSOR` | 400 | A paging or sync cursor that isn't one we issued → start again without it |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 1 MB (bodies are small JSON; files go to storage directly) |
| `RATE_LIMITED` | 429 | Too many requests. The `Retry-After` header says how many seconds to wait |
| `SERVICE_UNAVAILABLE` | 503 | A feature isn't configured on the server yet |
| `STORAGE_NOT_CONFIGURED` | 503 | File storage isn't set up on the server yet (uploads, downloads, thumbnails) |
| `STORAGE_UNAVAILABLE` | 503 | File storage didn't answer. Nothing changed → retry with backoff |
| `INTERNAL` | 500 | A server bug |

Endpoint-specific codes are listed with each endpoint.

**Headers to send on every request** (HOA protocol 11). All optional; garbled values are ignored,
never rejected:

```
X-App-Platform: android        # "android" | "ios" | "web"
X-App-Version: 1.4.2           # display version
X-App-Build: 1042              # integer build number (versionCode)
X-Device-Id: <install uuid>    # stable per-install id
```

**Data types**

- **IDs** are UUID strings. For folders, files and uploads the **app generates the id**, and writes are
  idempotent by id, so a retry after a dropped connection is always safe.
- **Money** is a decimal **string** of **paise**: `"4327"` is ₹43.27. Never a float, never rupees.
- **Sizes** are JSON numbers of **bytes**. 1 GB = 1,000,000,000 bytes, the unit phones display.
- **Timestamps** are ISO-8601 UTC strings. Billing days and months follow India time (`Asia/Kolkata`).

---

## 2. How BenchBox differs from the other House of Apps backends (plan ahead)

Each arrives as its own `BE-nnn` entry with the exact contract. They shape the client's architecture,
so they are listed together here:

- **Access tokens expire** (live since BE-002, §4). Sign-in returns a short-lived access token (1 hour)
  **and** a refresh token for the device. The app refreshes silently; users are never sent back to
  sign-in on a timer.
- **File bytes never go through this API** (live since BE-004, §8–9). The API hands out short-lived
  signed URLs; the app uploads to and downloads from cloud storage directly. Large uploads are
  multipart and resumable. Never cache a signed URL past its `expiresAt`.
- **The app makes the thumbnails** (BE-004). Each upload can include a small WebP preview made on the
  device.
- **Sync is a change feed** (live since BE-003, §7) with an opaque cursor, designed for a local Room
  cache. No device clocks are involved anywhere.

### Coming next (not built — plan the architecture, don't build against these shapes)

Listed so screens and navigation can be planned. Endpoint names and fields **will** change; each part
arrives as its own `BE-nnn` entry with the exact contract, and only then is it in this document.

- **Pay-as-you-use billing.** Users pay monthly for the storage they actually kept, measured by the day.
  Files in the trash count; thumbnails and unfinished uploads don't. 1 GB = 10⁹ bytes. The first GBs are
  free (the free allowance is already in `GET /api/v1/me/storage`). The app **never computes a charge**:
  it shows the amounts the server sends, as paise strings. Expect:
  - a **billing summary**: month-to-date amount, projected month-end amount, the cap, the payment
    method and the account standing;
  - **usage history** by day, and **monthly statements** (closed on the 1st, India time), with GST;
  - a **monthly cap** the user picks (₹100 by default, presets or a custom amount);
  - **UPI AutoPay / card mandate** setup: the app opens a payment-provider link and the user approves
    it in their UPI or card app; the server confirms it and the app refreshes;
  - **payment links** for an unpaid or above-cap amount, opened in the browser;
  - an **account standing** (good, past due, suspended) that can block uploads but keeps downloads
    working, so the app needs a banner and a "pay now" path.
- **Google Play credits.** Because of Play's policy for storage apps, the app shows Google's user-choice
  billing screen: "Google Play" (prepaid credit packs, bought in the app through Play) or "UPI AutoPay /
  card" (the mandate). Credits are used before the mandate is charged.
- **Notifications** (FCM, the push token already registered through `PUT /api/v1/me/push-token`):
  projected over the cap, 80% and 100% of the cap reached, bill ready, debit succeeded or failed. Each
  will carry a type and a deep-link target. Reaching the cap only notifies; uploads keep working.
- **Share links.** Share a file or folder as a link that expires (7 days by default) and can be revoked;
  recipients open a web page with no app needed. Android App Links will open it in the app when it's
  installed.

---

## 3. Endpoints

### `GET /` — health

Plain text `BenchBox Backend Running`. No auth.

### `GET /config` — remote config (HOA protocols 10/11)

The app's first call on launch. Nothing about the caller is required; send the headers from §1. The
response is `Cache-Control: no-store`; cache it yourself for `ttlSeconds` and re-fetch on every cold
start. Launch must never block on it: use compiled-in defaults, then the cached copy, then the network.

```json
{
  "success": true,
  "data": {
    "schemaVersion": 1,
    "variant": "default",
    "revision": "3f2a9c0d1b7e",
    "ttlSeconds": 3600,
    "config": {
      "features": { "uploads": true },
      "limits": { "maxFileSizeBytes": 10000000000, "maxThumbnailBytes": 262144 },
      "update": {
        "minSupportedBuild": 0,
        "recommendedBuild": 0,
        "androidStoreUrl": null,
        "iosStoreUrl": null,
        "message": null
      },
      "maintenance": { "enabled": false, "message": null },
      "links": {
        "privacyPolicy": "https://benchbox.ferbotz.com/privacy",
        "terms": "https://benchbox.ferbotz.com/terms",
        "deleteAccount": "https://benchbox.ferbotz.com/delete-account",
        "supportEmail": "support@ferbotz.com"
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `features.*` | Kill switches, `true` = on, one per feature as it ships. A key missing from the response means "use your compiled-in default (on)". |
| `features.uploads` | `false` → hide the upload entry points (the API itself keeps working, so uploads already under way can finish). |
| `limits.maxFileSizeBytes` | The largest file an upload may declare (10 GB). Check before starting; the server enforces this same value. |
| `limits.maxThumbnailBytes` | The largest thumbnail an upload may declare (256 KB). |
| `update.minSupportedBuild` | Builds below this must update to continue (hard block). `0` = none. |
| `update.recommendedBuild` | Builds below this get a dismissible update nudge. `0` = none. |
| `update.androidStoreUrl` / `iosStoreUrl` / `message` | Where to send the user, and optional copy. Nullable. |
| `maintenance.enabled` / `message` | `true` → show `message` instead of loading the app. |
| `links.*` | Absolute URLs of the legal pages and the support address. **Never hard-code these.** |

Keys are only ever added. Ignore keys you don't know.

### Legal pages — `GET /privacy`, `GET /terms`, `GET /delete-account`

Public HTML pages (aliases: `/privacy-policy`, `/terms-of-service`, `/account-deletion`). Open them from
`links.*` in an in-app browser (Custom Tabs on Android):

- **Settings / Profile / About:** "Privacy Policy", "Terms & Conditions", "Delete account", and
  "Contact support" (`mailto:` `links.supportEmail`).
- **Sign-in:** the consent line *"By continuing you agree to our Terms & Conditions and Privacy
  Policy"*, with both phrases linked.
- **Billing / purchase screens:** link the Terms and the Privacy Policy.

The delete-account page tells reviewers that the in-app path is **Settings → Account → Delete account**,
followed by a Google account confirmation (§5). If the app's screens end up named differently, send an
`APP-nnn` request so the page matches. Play reviewers follow the steps literally.

---

## 4. Sign-in and sessions

### The token model

1. **Sign in with Google** on the device (Credential Manager / "Sign in with Google") using BenchBox's
   **server client id** — the OAuth *web* client id, published in the contract folder once it exists.
   Until then `POST /api/v1/auth/google` answers `503 SERVICE_UNAVAILABLE`.
2. Send the resulting **idToken** to `POST /api/v1/auth/google`. You get back:
   - an `accessToken`, which lasts `expiresIn` seconds (3600);
   - a `refreshToken` for this device;
   - the `user`.
3. Send `Authorization: Bearer <accessToken>` on every `/api/v1` call **except** `/api/v1/auth/*`.
   Exclude those three endpoints from your bearer-auth plugin.
4. **When a protected call returns `401`** (`UNAUTHORIZED` or `INVALID_TOKEN`; the response carries
   `WWW-Authenticate: Bearer`):
   1. Call `POST /api/v1/auth/refresh` **once** with the stored refresh token.
   2. Store **both** new tokens: the refresh token changes on every refresh.
   3. Retry the original call.

   If the refresh itself fails (`INVALID_REFRESH_TOKEN` or `REFRESH_TOKEN_REUSED`), clear both tokens
   and show sign-in. A bearer plugin with a refresh callback, such as Ktor's `Auth`, is exactly this
   shape. You may also refresh ahead of time, shortly before `expiresIn` runs out.
5. **One refresh in flight at a time.** If a refresh times out and you never saw its response,
   retrying with the **same** refresh token within **60 seconds** is safe: you get fresh tokens. Outside
   that window, replaying an old refresh token is treated as theft, and the device is signed out
   (`REFRESH_TOKEN_REUSED`).
6. A device that isn't used for **90 days** is signed out (refresh returns `INVALID_REFRESH_TOKEN`).
7. **Store the refresh token encrypted**, using Android Keystore-backed storage. It is the long-lived
   credential, and the server only keeps its hash, so it can never be shown again.

One session exists per install: signing in again with the same `X-Device-Id` replaces that install's
session. Revocation is immediate: once a device is signed out (§5), its access token stops working at
once, not after the hour.

### `POST /api/v1/auth/google`

Send `X-Device-Id`, `X-App-Platform` and `X-App-Version` as on every request. They label this device in
the session list.

```json
{ "idToken": "<Google idToken>", "deviceName": "Pixel 8" }
```

`deviceName` is optional (at most 100 characters), shown in the device list.

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "expiresIn": 3600,
    "refreshToken": "q5Vn2…43 characters",
    "user": {
      "id": "388dbc11-d6f4-4232-adc1-11b9476f1f58",
      "email": "asha@example.com",
      "name": "Asha",
      "photoUrl": "https://lh3.googleusercontent.com/…",
      "createdAt": "2026-10-01T09:50:11.854Z"
    },
    "isNewUser": true
  }
}
```

| code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | `idToken` missing or not a string |
| `INVALID_ID_TOKEN` | 401 | Google rejected the idToken (wrong app, expired, forged, or no verified email) |
| `RATE_LIMITED` | 429 | Too many sign-ins from this network |
| `SERVICE_UNAVAILABLE` | 503 | Sign-in isn't configured on the server yet |

`user.email`, `name` and `photoUrl` come from the Google account and refresh on every sign-in. Any of
them can be `null`.

### `POST /api/v1/auth/refresh`

`{ "refreshToken": "<stored refresh token>" }` returns `{ "accessToken", "expiresIn", "refreshToken" }`
(no `user`).

| code | HTTP | When → what to do |
|---|---|---|
| `INVALID_REFRESH_TOKEN` | 401 | Unknown, expired or signed out → clear tokens, sign in |
| `REFRESH_TOKEN_REUSED` | 401 | The token was replayed after being replaced, so the device was signed out for security → clear tokens, sign in |

### `POST /api/v1/auth/logout`

`{ "refreshToken": "<stored refresh token>" }` returns `{}`, **always**, whether or not the token was
live. Call it on sign-out, then clear both tokens locally.

---

## 5. Account and devices (🔒 access token required)

### `GET /api/v1/me`

Returns the `user` object (same shape as in sign-in).

### `GET /api/v1/me/storage`

```json
{
  "success": true,
  "data": {
    "usedBytes": 1900000000,
    "trashBytes": 300000,
    "uploadingBytes": 0,
    "freeBytes": 2000000000,
    "limitBytes": 2000000000
  }
}
```

| Field | Meaning |
|---|---|
| `usedBytes` | Everything the account stores, **the trash included**: a file counts until it is permanently deleted. |
| `trashBytes` | The part of `usedBytes` that is in the trash. |
| `uploadingBytes` | Reserved by uploads still in progress. |
| `freeBytes` | The free allowance. |
| `limitBytes` | The most the account may store right now. Until billing launches it equals `freeBytes`; `null` will mean no limit. |

### `GET /api/v1/me/sessions`

The account's signed-in devices, most recently used first. `current` is `true` for the device making
the call, so label it "This device".

```json
{
  "success": true,
  "data": [
    {
      "id": "26d0806d-a242-485f-b99e-65fe3d12f67d",
      "deviceName": "Pixel 8",
      "platform": "android",
      "appVersion": "0.1.0",
      "createdAt": "2026-10-01T09:50:11.815Z",
      "lastUsedAt": "2026-10-01T09:50:11.815Z",
      "current": true
    }
  ]
}
```

`lastUsedAt` updates at most every 5 minutes.

### `DELETE /api/v1/me/sessions/{id}`

Signs out one device and returns `{}`. Using the current session's id signs out this device. An
unknown id, or another account's, returns `404 NOT_FOUND`.

### `POST /api/v1/me/sessions/revoke-others`

"Sign out all other devices" (e.g. after losing a phone). Returns `{ "revoked": 2 }`.

### `PUT /api/v1/me/push-token`

`{ "token": "<FCM registration token>" }` returns `{}`.
- **When to call:** after sign-in, and again whenever FCM rotates the token.
- **To stop notifications** on this device, send `{ "token": null }`.
- **Signing out** this device drops its token automatically.

Notifications themselves (usage alerts, bills) arrive in a later phase.

### `DELETE /api/v1/me` — delete the account

`{ "idToken": "<Google idToken from a FRESH sign-in>" }` returns `{}`.

Account deletion is irreversible and takes every stored file with it: the files stop counting at once
and are removed from storage within 7 days. So it needs proof that the owner is present, not just a
valid access token:
1. Run Google sign-in again (same server client id).
2. Send that idToken here within **10 minutes**.

On success:
- every device of the account is signed out;
- clear all local data and tokens;
- show a confirmation.

Signing in again later with the same Google account creates a **new, empty** account.

| code | HTTP | When → what to do |
|---|---|---|
| `BAD_REQUEST` | 400 | `idToken` missing |
| `REAUTH_REQUIRED` | 403 | The idToken was invalid or older than 10 minutes → run Google sign-in again and retry |
| `REAUTH_MISMATCH` | 403 | The user picked a different Google account → ask them to choose the one this BenchBox account uses |
| `RATE_LIMITED` | 429 | Too many attempts |
| `SERVICE_UNAVAILABLE` | 503 | Sign-in isn't configured on the server yet |

These are 403s, not 401s, so they don't trigger your token-refresh flow.

---

## 6. Files and folders (🔒 access token required)

### The node

Folders and files are both **nodes**, and every endpoint returns them in one shape. Folders are
created with `POST /api/v1/folders`; files by uploads (§8).

```json
{
  "id": "f94780da-cb57-449f-8114-b99d65aad94c",
  "parentId": null,
  "kind": "file",
  "name": "IMG_2041.jpg",
  "size": 3480122,
  "mimeType": "image/jpeg",
  "contentId": "7c0e1d52-9a4b-4f0a-8d1e-2b5c6a7f8e90",
  "hasThumbnail": true,
  "createdAt": "2026-10-09T15:46:18.516Z",
  "updatedAt": "2026-10-09T15:46:18.516Z",
  "trashedAt": null,
  "trashRootId": null,
  "deletedAt": null,
  "syncSeq": 7
}
```

| Field | Meaning |
|---|---|
| `id` | **Generated by the app** (a UUID) when it creates the node. |
| `parentId` | The containing folder, or `null` for the root. |
| `kind` | `"folder"` or `"file"`. |
| `name` | Trimmed and Unicode-normalised. Empty once `deletedAt` is set. |
| `size` | Files: bytes, as measured in storage (never just as declared). `0` for folders. |
| `mimeType` | Files: the type declared at upload. `null` for folders. |
| `contentId` | Files: changes when the content does (a replacing upload), **not** on rename or move. Use it as the cache key for the thumbnail and for a downloaded copy. `null` for folders and tombstones. |
| `hasThumbnail` | Files: whether `GET /api/v1/files/{id}/thumbnail` has an image (§9). |
| `trashedAt` | Set while in the trash. |
| `trashRootId` | While trashed, the item the user trashed. It equals `id` for the item shown in the trash, and its contents point at it. |
| `deletedAt` | Set once permanently deleted: a tombstone. Drop it from your cache. |
| `syncSeq` | The node's version. It goes up every time the node changes; send it back as `ifSeq`. |

**Names:**
- Between 1 and 255 bytes of UTF-8.
- Not `.` or `..`, and no `/`, `\` or control characters (`INVALID_NAME`).
- Unique within a folder **ignoring case**: "Photos" and "PHOTOS" can't sit side by side
  (`NAME_CONFLICT`).
- Items in the trash don't count towards uniqueness.

**Changes apply in the order they arrive.** To make an edit conditional, for example when replaying an
edit queued offline, send `ifSeq` with the `syncSeq` you last saw. If the node has changed since, you
get `409 NODE_CHANGED` and nothing is applied. Fetch the node, then decide.

### `POST /api/v1/folders`

```json
{ "id": "<new UUID>", "parentId": null, "name": "Photos", "onConflict": "fail" }
```

- `parentId` is optional; absent or `null` means the root.
- `onConflict` is `"fail"` (the default) or `"rename"`. `"rename"` picks the first free "Photos (1)",
  "Photos (2)", and so on.
- Returns **201** with the node when it was created.
- **Idempotent by `id`:** the same id again returns **200** with the folder as it is now. Retry freely.

| code | HTTP | When |
|---|---|---|
| `INVALID_NAME` | 400 | Name breaks the rules above |
| `NAME_CONFLICT` | 409 | Taken in that folder (with `onConflict: "fail"`) |
| `ID_CONFLICT` | 409 | That id is already used for something else → generate a new one |
| `NOT_FOUND` | 404 | The parent doesn't exist |
| `NODE_TRASHED` | 409 | The parent is in the trash |
| `NOT_A_FOLDER` | 409 | The parent is a file |

### `GET /api/v1/folders/{id}/children`

`{id}` is `root` or a folder id. Query parameters: `limit` (1–500, default 100) and `cursor`. Returns
`{ "items": [node…], "nextCursor": "…" | null, "hasMore": bool }`, **folders first, then files**, each
by name.

Page by passing `nextCursor` back while `hasMore` is true. A folder in the trash lists its trashed
contents, so the trash can be browsed.

### `GET /api/v1/nodes/{id}`

Returns the node, including when it's in the trash. A permanently deleted node, or a malformed or
foreign id, gets `404`.

### `PATCH /api/v1/nodes/{id}` — rename and/or move

`{ "name"?: "New name", "parentId"?: "<folder id>" | null, "ifSeq"?: 7 }` returns the node.

| code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Neither `name` nor `parentId` sent |
| `NAME_CONFLICT` | 409 | The name is taken at the destination |
| `MOVE_INTO_SELF` | 409 | Moving a folder into itself or one of its subfolders |
| `NODE_TRASHED` | 409 | The node, or the destination, is in the trash → restore first |
| `NODE_CHANGED` | 409 | `ifSeq` no longer matches |
| `NOT_FOUND` | 404 | Node or destination not found |

### Trash

- **`POST /api/v1/nodes/{id}/trash`** moves the node **and everything inside it** to the trash as one
  batch, and returns the node. Calling it again is fine.
- **`GET /api/v1/trash`** lists what the user trashed, most recent first, paged like children. Only the
  trashed items themselves are listed, not their contents.
- **`POST /api/v1/nodes/{id}/restore`** brings back a trashed item **with everything trashed with it**,
  and returns the node.
  - It goes back to its folder, or to the root if that folder is gone or itself in the trash.
  - If the name is taken there, it becomes "Name (1)".
  - Restoring something *inside* a trashed folder returns `409 NOT_TRASH_ROOT`: restore the folder.
- **`DELETE /api/v1/nodes/{id}`** permanently deletes a trashed node and everything under it, returning
  `{}`. Only from the trash (`409 NOT_IN_TRASH` otherwise); calling it again is fine.
- **`DELETE /api/v1/trash`** empties the trash and returns `{ "purged": 12 }`.
- **The trash empties itself:** anything in the trash for **30 days** is permanently deleted. The
  privacy policy promises this.
- **Files in the trash still count** towards storage until permanently deleted (show `trashBytes`
  from `GET /api/v1/me/storage` on the trash screen). Permanent deletion frees the space at once.

### `GET /api/v1/search?q=holiday`

Returns nodes whose name contains `q`: case-insensitive, outside the trash, by name. Takes `limit` and
`cursor` and pages like children. `%` and `_` are matched literally. An empty `q` gets `400`.

---

## 7. Sync — the change feed (🔒)

### `GET /api/v1/sync/changes?cursor=…&limit=…`

```json
{
  "success": true,
  "data": {
    "changes": [ { "…node…": "" } ],
    "nextCursor": "eyJzIjoiMTIiLCJpIjoi…",
    "hasMore": false
  }
}
```

Use it like this:

1. **First run, or after a resync:** call it **without** a cursor. You get every node, in pages of up
   to `limit` (1–1000, default 500), including items in the trash and recent tombstones. Follow
   `nextCursor` while `hasMore` is true.
2. **Store `nextCursor`** after every page. It's always set, even on a page with no changes.
3. **Afterwards**, call it with the stored cursor on app start, after your own writes, and on pull to
   refresh. You get only what changed since, including changes from your other devices and from the
   server (e.g. the 30-day trash purge).
4. **Apply each change by `id`:** upsert the node, or delete it locally when `deletedAt` is set. A node
   appears once per page with its **latest** state, not once per edit.
5. **`410 RESYNC_REQUIRED`:** the device has been away so long (90 days) that old deletes were
   discarded. Clear the local tree and do step 1 again.

The feed is ordered by the server's commit order, so it never skips a change, and no device clocks
are involved. Everything changed in one action (e.g. trashing a folder of 50 items) arrives together
with the same `syncSeq`.

---

## 8. Uploads (🔒)

File bytes go **straight from the app to cloud storage** (Cloudflare R2) through short-lived signed
URLs. This API starts uploads, hands out the URLs, and records the file once the bytes are in.

### The flow

1. **Generate two UUIDs:** the upload's `id` and the new file's `fileId`. Store them with the queued
   upload, so every retry reuses them.
2. **Make the thumbnail** (images and videos): a WebP, at most 512 px on the long side and at most
   `limits.maxThumbnailBytes`. Note its exact size in bytes.
3. **`POST /api/v1/uploads`** → the upload, and where to send the bytes.
4. **Send the bytes:**
   - `mode: "single"` (files up to 16 MiB): `PUT` the whole file to `put.url`.
   - `mode: "multipart"`: get part URLs from `POST /api/v1/uploads/{id}/parts`, up to 50 at a time,
     and `PUT` each part. Three or four in parallel is a good default.
   - If you declared a thumbnail, `PUT` it to `thumbnailPut.url`.
5. **`POST /api/v1/uploads/{id}/complete`** → the upload, now `completed`, with the file in `node`.

**Sending bytes to a signed URL:**
- `PUT` with the body's exact length as `Content-Length` (a file or byte-array body does this; don't
  stream chunked). Each URL is signed for one exact size, and any other size is refused (`403`).
- Send the URL's `headers` exactly as given (empty today). Never send your `Authorization` header to
  storage.
- A URL works until its `expiresAt` (at most an hour). For fresh ones, `GET` the upload (whole file,
  thumbnail) or call the parts endpoint again (parts).
- Never log or store signed URLs: whoever holds one can use it until it expires.

### `POST /api/v1/uploads` — start

```json
{
  "id": "<new UUID>",
  "fileId": "<new UUID>",
  "parentId": null,
  "name": "IMG_2041.jpg",
  "size": 3480122,
  "mimeType": "image/jpeg",
  "onConflict": "fail",
  "thumbnail": { "size": 18342 }
}
```

- `size`: the file's exact bytes, at most `limits.maxFileSizeBytes`. `0` is allowed.
- `parentId`: a folder, or `null`/absent for the root.
- `mimeType`: optional, default `application/octet-stream`. Parameters (`; charset=utf-8`) are
  dropped. Downloads are served with this type.
- `onConflict`, for a name already taken in the folder (ignoring case):
  - `"fail"` (default): `409 NAME_CONFLICT` now, before any bytes move.
  - `"rename"`: "IMG_2041 (1).jpg".
  - `"replace"`: the new content replaces the existing **file** of that name. That file keeps its id,
    name and place, so **the `node` you get back has the existing file's id, not your `fileId`**. Its
    old content is deleted; there is no version history. A folder is never replaced: the new file is
    numbered instead.
- `thumbnail`: optional, `{ "size": <exact bytes> }`.

Returns **201** with the upload, or **200** if this `id` already exists (retry freely):

```json
{
  "success": true,
  "data": {
    "id": "3b6f…", "fileId": "f947…", "parentId": null,
    "name": "IMG_2041.jpg", "size": 3480122, "mimeType": "image/jpeg", "onConflict": "fail",
    "state": "pending",
    "mode": "single", "partSize": null, "partCount": null,
    "expiresAt": "2026-10-23T10:00:00.000Z",
    "put": { "url": "https://…", "method": "PUT", "headers": {}, "expiresAt": "2026-10-22T11:00:00.000Z" },
    "thumbnailPut": { "url": "https://…", "method": "PUT", "headers": {}, "expiresAt": "2026-10-22T11:00:00.000Z" },
    "uploadedParts": null,
    "node": null
  }
}
```

- **`expiresAt` (the upload's):** an upload untouched for 24 hours expires and its partial bytes are
  deleted. Every call about it pushes that back, up to 6 days after it started.
- **Multipart:** `partSize` is the size of every part but the last; part *n* is bytes
  `(n−1)·partSize` up to `n·partSize`, and the last part is whatever remains.
- **`state`:** `pending`, `completed`, `aborted`, `expired` or `failed`.

| code | HTTP | When → what to do |
|---|---|---|
| `INVALID_NAME`, `NAME_CONFLICT`, `NOT_FOUND`, `NODE_TRASHED`, `NOT_A_FOLDER` | | As for folders (§6) |
| `ID_CONFLICT` | 409 | The `id` or `fileId` is already used for something else → new UUIDs |
| `INVALID_MIME_TYPE` | 400 | `mimeType` isn't `type/subtype` |
| `FILE_TOO_LARGE` | 413 | `size` is over `limits.maxFileSizeBytes` |
| `STORAGE_LIMIT_REACHED` | 402 | The account would go past `limitBytes` (`GET /api/v1/me/storage`). Until billing launches, that is the free allowance. |
| `TOO_MANY_UPLOADS` | 409 | 50 uploads are already in progress → finish or cancel some |
| `RATE_LIMITED` | 429 | More than 600 starts in 5 minutes |

### `POST /api/v1/uploads/{id}/parts` — part URLs (multipart)

`{ "partNumbers": [1, 2, 3] }`: 1–50 distinct numbers from 1 to `partCount`. Returns:

```json
{
  "success": true,
  "data": {
    "parts": [
      { "partNumber": 1, "size": 8388608, "url": "https://…", "method": "PUT", "headers": {}, "expiresAt": "…" }
    ]
  }
}
```

Each URL is signed for that part's exact `size`. Sending a part again replaces it. A single upload
answers `400 NOT_MULTIPART`.

### `GET /api/v1/uploads/{id}` — resume

After a dropped connection, or the app being killed:
- **Multipart:** `uploadedParts` lists the parts storage already holds at the right size. Get URLs
  for the rest, send them, then complete.
- **Single:** call complete first. If it answers `UPLOAD_INCOMPLETE`, `PUT` the file again to the
  fresh `put.url` from this response.
- `thumbnailPut` is fresh too.
- No longer `pending`? `completed`: the file is in `node`. `aborted`, `expired` or `failed`: start a
  new upload with new ids.

### `POST /api/v1/uploads/{id}/complete` — finish

Body optional: `{ "onConflict": "rename" }` overrides the upload's choice (see `NAME_CONFLICT` below).

The server measures what storage actually holds (the declared size is never trusted) and then, in
one step, the file appears in its folder and in the sync feed, starts counting towards storage, and
the upload becomes `completed`. Returns the upload with its `node`. Completing again returns the same
file.

- If the folder was deleted or trashed meanwhile, the file lands in the **root**.
- Upload the thumbnail **before** completing. One sent later is ignored, and deleted.

| code | HTTP | When → what to do |
|---|---|---|
| `UPLOAD_INCOMPLETE` | 409 | Parts, or the file, are missing → `GET` the upload, send what's missing, complete again |
| `NAME_CONFLICT` | 409 | With `"fail"`, the name was taken while you uploaded. Nothing is lost: ask the user, then complete again with `{ "onConflict": "rename" }` or `"replace"` |
| `SIZE_MISMATCH` | 409 | Storage holds a different number of bytes than declared. The upload is now `failed` → start a new one |
| `UPLOAD_ENDED` | 410 | Cancelled, expired or failed → start a new upload with new ids |
| `ID_CONFLICT` | 409 | The `fileId` became taken (an app bug) → cancel, and start again with new ids |

### `DELETE /api/v1/uploads/{id}` — cancel

Returns `{}`, and calling it again is fine. Whatever was uploaded is deleted about 75 minutes later,
once every URL handed out for it has expired. A completed upload can't be cancelled
(`409 UPLOAD_COMPLETED`): trash the file instead.

**On every upload endpoint:** `404 NOT_FOUND` for an unknown upload (or another account's);
`503 STORAGE_NOT_CONFIGURED` / `STORAGE_UNAVAILABLE` as in §1.

---

## 9. Downloads and thumbnails (🔒)

### `GET /api/v1/files/{id}/download`

```json
{ "success": true, "data": { "url": "https://…", "expiresAt": "2026-10-22T10:15:00.000Z" } }
```

- The URL works for **15 minutes**. It serves the file with its real name and type
  (`Content-Disposition: attachment`), and supports `Range`, so a download can resume and a video can
  seek. After it expires, ask again.
- Files in the trash can be downloaded too.
- `404` for a folder, a permanently deleted file, or another account's id.

### `GET /api/v1/files/{id}/thumbnail`

A stable URL per file, for your image loader:
- Request it with your `Authorization` header (on Android, an OkHttp interceptor for this host).
- It answers **302** to the image: a WebP, valid for an hour. HTTP clients drop `Authorization` when a
  redirect changes host, so the token never reaches storage.
- Cache the image by the node's **`contentId`**. It changes only when the content does, so renames
  and moves keep the cached thumbnail (Coil: set `diskCacheKey` and `memoryCacheKey` to `contentId`).
- `404` when the file has no thumbnail (`hasThumbnail: false`): show a placeholder for its type.
