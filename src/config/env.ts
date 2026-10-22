import dotenv from "dotenv";
import { parseDurationSeconds } from "../common/duration";

// Load variables from .env into process.env as early as possible. `quiet` suppresses dotenv
// v17's startup banner (and the harmless "injected env (0)" line in containers, where variables
// come from compose's env_file rather than a .env inside the image).
dotenv.config({ quiet: true });

// Fail fast if a required variable is missing, so we never run with an undefined value.
const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
};

// An absolute http(s) origin with no path, query or trailing slash — e.g. https://brimbox.ferbotz.com.
// Links are built as `${origin}/privacy`, so anything else would produce broken URLs.
const requireOrigin = (key: string): string => {
  const raw = requireEnv(key);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Environment variable ${key} must be an absolute URL (got "${raw}")`);
  }
  const isHttp = url.protocol === "https:" || url.protocol === "http:";
  if (!isHttp || url.pathname !== "/" || url.search || url.hash || raw.endsWith("/")) {
    throw new Error(
      `Environment variable ${key} must be an origin like https://brimbox.ferbotz.com — ` +
        `http(s), no path, no trailing slash (got "${raw}")`
    );
  }
  return url.origin;
};

const parsePort = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Environment variable ${key} must be a port number (got "${raw}")`);
  }
  return port;
};

// A required secret, long enough to be a real one. A short value is almost always a placeholder
// that slipped into production.
const requireSecret = (key: string, minLength: number): string => {
  const value = requireEnv(key);
  if (value.length < minLength) {
    throw new Error(`Environment variable ${key} must be at least ${minLength} characters`);
  }
  return value;
};

// A comma-separated list; unset or blank → [].
const parseList = (key: string): string[] =>
  (process.env[key] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

// How long an access token lives, in seconds. HOA protocol 04 defaults JWT_EXPIRES_IN to "never";
// BrimBox deviates (D1 in docs/BACKEND_PLAN.md): access tokens always expire — the app refreshes
// them silently with its refresh token — so "never" is refused rather than quietly honoured.
const ACCESS_TOKEN_TTL_MIN_SECONDS = 60;
const ACCESS_TOKEN_TTL_MAX_SECONDS = 24 * 60 * 60;
const parseAccessTokenTtl = (key: string, fallback: string): number => {
  const raw = (process.env[key] ?? "").trim() || fallback;
  if (raw.toLowerCase() === "never") {
    throw new Error(
      `${key}=never is not supported in BrimBox: access tokens must expire (refresh tokens keep ` +
        `users signed in). Use a duration such as "1h".`
    );
  }
  const seconds = parseDurationSeconds(raw);
  if (
    seconds === null ||
    seconds < ACCESS_TOKEN_TTL_MIN_SECONDS ||
    seconds > ACCESS_TOKEN_TTL_MAX_SECONDS
  ) {
    throw new Error(
      `Environment variable ${key} must be a duration between 1m and 24h, like "1h" or "900s" ` +
        `(got "${raw}")`
    );
  }
  return seconds;
};

// Parses an OPTIONAL env var holding a JSON object. Unset/blank -> null. Invalid JSON or a
// non-object -> throw, so a mistyped value fails the boot (like requireEnv) instead of being
// quietly ignored.
const parseJsonObjectEnv = (key: string): Record<string, unknown> | null => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Environment variable ${key} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Environment variable ${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

export interface R2Config {
  /** S3 API endpoint: https://<account id>.r2.cloudflarestorage.com, unless R2_ENDPOINT overrides it. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Cloudflare R2, where file bytes live (deviation D2). An optional integration: ALL of its keys or
// NONE. With none, the API still runs and the file endpoints answer 503; a partial set is almost
// always a paste mistake, so it fails the boot instead of half-working.
const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const parseR2Config = (): R2Config | null => {
  const present = R2_KEYS.filter((key) => (process.env[key] ?? "").trim().length > 0);
  if (present.length === 0) return null;
  if (present.length < R2_KEYS.length) {
    const missing = R2_KEYS.filter((key) => !present.includes(key));
    throw new Error(`R2 is partly configured: set all of ${R2_KEYS.join(", ")} or none (missing ${missing.join(", ")})`);
  }
  const accountId = requireEnv("R2_ACCOUNT_ID");
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new Error("R2_ACCOUNT_ID must be the 32-character Cloudflare account id");
  }
  const bucket = requireEnv("R2_BUCKET");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`R2_BUCKET must be an R2 bucket name, like brimbox-files (got "${bucket}")`);
  }
  // Optional: another S3-compatible endpoint, for a local stand-in. Production leaves it unset.
  const override = (process.env.R2_ENDPOINT ?? "").trim();
  if (override && !/^https?:\/\/[^/]+$/.test(override)) {
    throw new Error(`R2_ENDPOINT must be an origin like https://host:port (got "${override}")`);
  }
  return {
    endpoint: override || `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireSecret("R2_SECRET_ACCESS_KEY", 32),
  };
};

// Centralized, typed configuration. The ONLY reader of process.env (HOA protocol 04) — import
// this instead of reading the environment anywhere else.
export const config = {
  port: parsePort("PORT", 8080),
  // Public origin of this backend. The legal pages' absolute URLs in GET /config → links are
  // built from it (HOA protocol 12), so it is the one place the host name is written down.
  appPublicUrl: requireOrigin("APP_PUBLIC_URL"),
  // PostgreSQL. Required at startup but not needed to answer GET /config or the legal pages:
  // Prisma connects lazily, so those keep working while the database is unreachable.
  databaseUrl: requireEnv("DATABASE_URL"),
  // Signs access tokens (HS256). Rotating it invalidates outstanding ACCESS tokens only: apps
  // refresh within the hour with their refresh tokens (stored as hashes in the database), so —
  // unlike the house default — rotation does not sign everyone out.
  jwtSecret: requireSecret("JWT_SECRET", 32),
  accessTokenTtlSeconds: parseAccessTokenTtl("JWT_EXPIRES_IN", "1h"),
  // Google OAuth client id(s) a sign-in idToken's `aud` may carry — the WEB client id the app
  // passes as its server client id, comma-separated if there is more than one. Unset → sign-in
  // answers 503 instead of failing the boot, so the rest of the API can run before the OAuth
  // client exists.
  googleClientIds: parseList("GOOGLE_CLIENT_ID"),
  // Optional JSON patch applied over the default remote config (GET /config) for every caller,
  // e.g. {"maintenance":{"enabled":true,"message":"Back in 10 minutes"}}. Lets ops flip a flag
  // with an .env change + container recreate — no code deploy. Every key must exist in
  // DEFAULT_REMOTE_CONFIG with a matching type; anything else fails startup on purpose
  // (validated in remoteConfig.service.ts). See docs/REMOTE_CONFIG.md.
  remoteConfigOverrides: parseJsonObjectEnv("REMOTE_CONFIG_OVERRIDES"),
  // File storage (Cloudflare R2). null → uploads, downloads and the storage jobs answer 503 / skip.
  r2: parseR2Config(),
};
