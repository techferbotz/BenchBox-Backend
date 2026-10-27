// Fixture checks for sign-in and sessions (HOA protocol 04: small ts-node scripts, no test
// framework). Pure — no database, no network:
//
//   npm run check:auth
//
// Pins the security-relevant decisions: access-token signing and rejection, refresh-token shape,
// every branch of the rotation decision, the re-auth rule for destructive actions, how a verified
// Google payload becomes an identity, and that a request body a client broke is a 4xx, never a
// 500. The database-backed flows are check:auth-db.

// googleVerifier imports config/env.ts, which fails fast on missing REQUIRED vars. Placeholders for
// any that are missing, set BEFORE the imports below load it (tsc keeps statement order in CommonJS).
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://benchbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { parseDurationSeconds } from "../common/duration";
import { errorHandler } from "../common/errors/errorHandler";
import {
  createAccessTokenSigner,
  generateRefreshToken,
  hashToken,
  tokenRejectionReason,
} from "../common/utils/tokens";
import { identityFromPayload } from "../integrations/googleVerifier";
import { REFRESH_RETRY_GRACE_SECONDS, REFRESH_TOKEN_IDLE_DAYS, REAUTH_MAX_AGE_SECONDS } from "../modules/auth/auth.policy";
import {
  checkReauth,
  decideRefresh,
  RefreshCandidate,
  sessionIdleExpiry,
  shouldTouchLastUsed,
} from "../modules/auth/auth.rules";

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

const SECRET = "check-secret-0123456789-0123456789-abcdef";
const T0 = Date.parse("2026-10-01T10:00:00Z");
const signer = createAccessTokenSigner(SECRET, 3600);
const claims = { userId: "6f1e2d3c-0000-4000-8000-000000000001", sessionId: "6f1e2d3c-0000-4000-8000-0000000000aa" };

const rejects = (fn: () => unknown, reason: RegExp): void => {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected a rejection");
  assert.match(tokenRejectionReason(thrown), reason);
};

// ---------------------------------------------------------------- durations (JWT_EXPIRES_IN)
check("duration: units and bare seconds parse; junk does not", () => {
  assert.equal(parseDurationSeconds("1h"), 3600);
  assert.equal(parseDurationSeconds("15m"), 900);
  assert.equal(parseDurationSeconds("900s"), 900);
  assert.equal(parseDurationSeconds("900"), 900);
  assert.equal(parseDurationSeconds("2d"), 172800);
  for (const junk of ["never", "", "1.5h", "-1h", "1 hour", "h", "10y"]) {
    assert.equal(parseDurationSeconds(junk), null, `"${junk}" must not parse`);
  }
});

// ---------------------------------------------------------------- access tokens
check("access token: round-trips, carries user + session, reports its lifetime", () => {
  const { token, expiresIn } = signer.sign(claims, T0);
  assert.equal(expiresIn, 3600);
  assert.deepEqual(signer.verify(token, T0 + 3599_000), claims);
});

check("access token: expires exactly at its lifetime", () => {
  const { token } = signer.sign(claims, T0);
  rejects(() => signer.verify(token, T0 + 3600_000), /jwt expired/);
});

check("access token: another secret, a tampered payload, or alg=none is rejected", () => {
  const { token } = signer.sign(claims, T0);
  rejects(() => createAccessTokenSigner("some-other-secret-0123456789-0123456789", 3600).verify(token, T0), /invalid signature/);

  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "someone-else", sid: claims.sessionId, iat: T0 / 1000, exp: T0 / 1000 + 3600 })).toString("base64url");
  rejects(() => signer.verify(`${header}.${forged}.${signature}`, T0), /invalid signature/);

  const unsigned = jwt.sign({ sub: claims.userId, sid: claims.sessionId }, "", { algorithm: "none" });
  rejects(() => signer.verify(unsigned, T0), /jwt signature is required|invalid algorithm/);
});

check("access token: a validly signed token without a session id is rejected", () => {
  const noSid = jwt.sign({ sub: claims.userId, iat: T0 / 1000 }, SECRET, { algorithm: "HS256", expiresIn: 60 });
  rejects(() => signer.verify(noSid, T0), /missing sub\/sid/);
});

// ---------------------------------------------------------------- refresh tokens
check("refresh token: 256-bit, URL-safe, unique; only its SHA-256 is ever stored", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const token = generateRefreshToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 1000);
  const token = generateRefreshToken();
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(generateRefreshToken()));
});

// ---------------------------------------------------------------- rotation decision
const now = new Date(T0);
const session = (over: Partial<RefreshCandidate> = {}): RefreshCandidate => ({
  id: "s-1",
  userId: "u-1",
  expiresAt: new Date(T0 + 86_400_000),
  rotatedAt: null,
  ...over,
});

check("refresh decision: the current token rotates", () => {
  assert.deepEqual(decideRefresh(session(), null, now), { kind: "rotate", sessionId: "s-1", userId: "u-1" });
});

check("refresh decision: the replaced token inside the grace window is a retry", () => {
  const rotatedAt = new Date(T0 - (REFRESH_RETRY_GRACE_SECONDS - 1) * 1000);
  assert.equal(decideRefresh(null, session({ rotatedAt }), now).kind, "retry");
  const edge = new Date(T0 - REFRESH_RETRY_GRACE_SECONDS * 1000);
  assert.equal(decideRefresh(null, session({ rotatedAt: edge }), now).kind, "retry");
});

check("refresh decision: the replaced token after the grace window is theft", () => {
  const rotatedAt = new Date(T0 - (REFRESH_RETRY_GRACE_SECONDS + 1) * 1000);
  assert.deepEqual(decideRefresh(null, session({ rotatedAt }), now), { kind: "reuse", sessionId: "s-1", userId: "u-1" });
});

check("refresh decision: an idle-expired session is expired, whichever token is presented", () => {
  const expired = { expiresAt: new Date(T0) };
  assert.equal(decideRefresh(session(expired), null, now).kind, "expired");
  assert.equal(decideRefresh(null, session({ ...expired, rotatedAt: new Date(T0 - 1000) }), now).kind, "expired");
});

check("refresh decision: an unknown token is unknown", () => {
  assert.deepEqual(decideRefresh(null, null, now), { kind: "unknown" });
});

check("session idle expiry: now + the idle window", () => {
  assert.equal(sessionIdleExpiry(now).getTime(), T0 + REFRESH_TOKEN_IDLE_DAYS * 86_400_000);
});

check("lastUsedAt: written at most every interval", () => {
  assert.equal(shouldTouchLastUsed(new Date(T0 - 60_000), now), false);
  assert.equal(shouldTouchLastUsed(new Date(T0 - 300_000), now), true);
});

// ---------------------------------------------------------------- re-auth for destructive actions
check("re-auth: a fresh sign-in for the same account passes", () => {
  assert.deepEqual(checkReauth({ sub: "g-1", issuedAt: T0 / 1000 - 60 }, "g-1", now), { ok: true });
});

check("re-auth: a different account, or a deleted one, is a mismatch", () => {
  assert.deepEqual(checkReauth({ sub: "g-2", issuedAt: T0 / 1000 }, "g-1", now), { ok: false, reason: "mismatch" });
  assert.deepEqual(checkReauth({ sub: "g-1", issuedAt: T0 / 1000 }, null, now), { ok: false, reason: "mismatch" });
});

check("re-auth: a sign-in older than the limit is stale", () => {
  const old = T0 / 1000 - REAUTH_MAX_AGE_SECONDS - 1;
  assert.deepEqual(checkReauth({ sub: "g-1", issuedAt: old }, "g-1", now), { ok: false, reason: "stale" });
});

// ---------------------------------------------------------------- Google payload → identity
check("google: a verified payload becomes an identity", () => {
  const identity = identityFromPayload({
    iss: "https://accounts.google.com",
    aud: "web-client",
    sub: "1234567890",
    email: "asha@example.com",
    email_verified: true,
    name: "  Asha  ",
    picture: "https://lh3.googleusercontent.com/a/x",
    iat: 1790000000,
    exp: 1790003600,
  });
  assert.deepEqual(identity, {
    sub: "1234567890",
    email: "asha@example.com",
    name: "Asha",
    photoUrl: "https://lh3.googleusercontent.com/a/x",
    issuedAt: 1790000000,
  });
});

check("google: unverified email, missing email, missing sub or iat are refused", () => {
  const base = { iss: "https://accounts.google.com", aud: "web-client", sub: "1", email: "a@b.c", email_verified: true, iat: 1, exp: 2 };
  const refused = (payload: object | undefined): void => {
    assert.throws(
      () => identityFromPayload(payload as Parameters<typeof identityFromPayload>[0]),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ID_TOKEN"
    );
  };
  refused({ ...base, email_verified: false });
  refused({ ...base, email: undefined });
  refused({ ...base, sub: "" });
  refused({ ...base, iat: undefined });
  refused(undefined);
  // A blank display name is just absent.
  assert.equal(identityFromPayload({ ...base, name: "   " }).name, null);
});

// ---------------------------------------------------------------- request bodies
check("a body the client broke is a 4xx, never a 500: malformed, too large, corrupt or trailing compressed bytes", () => {
  interface StubResponse {
    statusCode: number;
    body: { code?: string };
    headersSent: boolean;
    status(code: number): StubResponse;
    json(body: { code?: string }): StubResponse;
    set(): StubResponse;
  }
  const respond = (err: unknown): [number, string] => {
    const res: StubResponse = {
      statusCode: 0,
      body: {},
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
      set() {
        return this;
      },
    };
    errorHandler(err, {} as Request, res as unknown as Response, () => undefined);
    return [res.statusCode, res.body.code ?? ""];
  };
  // As express.json() raises them (http-errors: `expose` and a 4xx status).
  const bodyError = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), { expose: true, ...props });
  assert.deepEqual(respond(bodyError("Unexpected end of JSON input", { type: "entity.parse.failed", status: 400 })), [400, "INVALID_JSON"]);
  assert.deepEqual(respond(bodyError("request entity too large", { type: "entity.too.large", status: 413 })), [413, "PAYLOAD_TOO_LARGE"]);
  // body-parser ≥ 2.4 refuses bytes after a gzip stream with a bare zlib error (GHSA-27r3-jxmh-p828).
  assert.deepEqual(respond(bodyError("incorrect header check", { code: "Z_DATA_ERROR", status: 400, statusCode: 400 })), [400, "BAD_REQUEST"]);
  assert.deepEqual(respond(bodyError('unsupported content encoding "compress"', { type: "encoding.unsupported", status: 415 })), [400, "BAD_REQUEST"]);
  // Anything else is a bug: 500 (and logged, here silenced).
  const log = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(respond(new Error("boom")), [500, "INTERNAL"]);
    assert.deepEqual(respond(Object.assign(new Error("not for clients"), { status: 400 })), [500, "INTERNAL"], "no `expose`, no 400");
  } finally {
    console.error = log;
  }
});

console.log(`\ncheck:auth — ${passed} checks passed`);
