// Integration checks for sign-in and sessions against a real PostgreSQL — a LOCAL, disposable
// database only; the script refuses anything else:
//
//   npm run check:auth-db        (DATABASE_URL from .env, schema migrated)
//
// Runs the real AuthService and AccountService through the repositories and the schema, with a
// fake Google verifier and a clock the script moves forward. Prisma is used directly only to
// inspect state and to clean up the rows this run created.

import dotenv from "dotenv";
dotenv.config({ quiet: true });

let dbHost = "";
try {
  dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  dbHost = "";
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(dbHost)) {
  console.error("check:auth-db runs only against a LOCAL database (DATABASE_URL host must be localhost). Refusing.");
  process.exit(1);
}
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://brimbox.ferbotz.com",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { prisma } from "../prisma/client";
import { UnauthorizedError } from "../common/errors/AppError";
import { createAccessTokenSigner } from "../common/utils/tokens";
import { GoogleIdentity } from "../integrations/googleVerifier";
import { REAUTH_MAX_AGE_SECONDS, REFRESH_RETRY_GRACE_SECONDS, REFRESH_TOKEN_IDLE_DAYS } from "../modules/auth/auth.policy";
import { AuthService, INVALID_REFRESH_TOKEN, REFRESH_TOKEN_REUSED } from "../modules/auth/service/auth.service";
import { AccountService } from "../modules/account/service/account.service";
import { DeviceInfo } from "../modules/auth/dto/auth.dto";

// ---------------------------------------------------------------- harness
let clock = new Date("2026-10-01T10:00:00Z");
const now = (): Date => clock;
const advance = (seconds: number): void => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

// The fake Google: an "idToken" is "<sub>|<iat seconds>".
const RUN = Date.now().toString(36);
const sub = (name: string): string => `check-${RUN}-${name}`;
const idTokenFor = (googleSub: string, issuedAt = Math.floor(clock.getTime() / 1000)): string =>
  `${googleSub}|${issuedAt}`;
const fakeVerify = async (idToken: string): Promise<GoogleIdentity> => {
  const [s, iat] = idToken.split("|");
  if (!s || !iat) throw new UnauthorizedError("Google sign-in could not be verified", "INVALID_ID_TOKEN");
  return { sub: s, email: `${s}@example.test`, name: `Name ${s}`, photoUrl: null, issuedAt: Number(iat) };
};

const signer = createAccessTokenSigner("check-db-secret-0123456789-0123456789-abc", 3600);
const auth = new AuthService({ verifyIdToken: fakeVerify, accessTokens: signer, now });
const account = new AccountService({ verifyIdToken: fakeVerify, now });
const device = (deviceId: string | null, deviceName = "Pixel 8"): DeviceInfo => ({
  deviceId,
  deviceName,
  platform: "android",
  appVersion: "0.1.0",
});

const createdUserIds = new Set<string>();
const signIn = async (googleSub: string, deviceId: string | null) => {
  const res = await auth.signInWithGoogle(idTokenFor(googleSub), device(deviceId));
  createdUserIds.add(res.user.id);
  return res;
};
const sessionIdOf = async (accessToken: string): Promise<string> => {
  const who = await auth.authenticate(accessToken);
  assert.ok(who, "expected a live session");
  return who.sessionId;
};
const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => {
    assert.equal((e as { code?: string }).code, code);
    return true;
  });
};

const cleanup = async (): Promise<void> => {
  // Account deletion queues sweeps of the account's storage (outbox jobs naming its id).
  for (const id of createdUserIds) await prisma.$executeRaw`DELETE FROM "OutboxJob" WHERE "payload"::text LIKE ${`%${id}%`}`;
  await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  await prisma.$disconnect();
};

let passed = 0;
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    await cleanup();
    process.exit(1);
  }
};

// ---------------------------------------------------------------- flows
const main = async (): Promise<void> => {
  await check("sign-in: first sign-in creates the account and one device session", async () => {
    const res = await signIn(sub("a"), "install-a1");
    assert.equal(res.isNewUser, true);
    assert.equal(res.user.email, `${sub("a")}@example.test`);
    const rows = await prisma.session.findMany({ where: { userId: res.user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.deviceId, "install-a1");
    assert.notEqual(rows[0]?.refreshTokenHash, res.refreshToken, "only the hash is stored");
    assert.equal(await sessionIdOf(res.accessToken), rows[0]?.id);
  });

  await check("sign-in: the same install signing in again replaces its session", async () => {
    const first = await signIn(sub("b"), "install-b1");
    const again = await signIn(sub("b"), "install-b1");
    assert.equal(again.isNewUser, false);
    assert.equal(again.user.id, first.user.id);
    assert.equal(await prisma.session.count({ where: { userId: first.user.id } }), 1);
    assert.equal(await auth.authenticate(first.accessToken), null, "the replaced session is signed out");
  });

  await check("sessions: a second device adds a session; the list marks the current one", async () => {
    const phone = await signIn(sub("c"), "install-c1");
    const tablet = await signIn(sub("c"), "install-c2");
    const list = await account.listSessions(phone.user.id, await sessionIdOf(tablet.accessToken));
    assert.equal(list.length, 2);
    assert.equal(list.filter((s) => s.current).length, 1);
    assert.ok(list.every((s) => s.deviceName === "Pixel 8" && s.platform === "android"));
  });

  await check("refresh: rotation, a lost-response retry, then theft revokes the session", async () => {
    const res = await signIn(sub("d"), "install-d1");
    advance(300);
    const r1 = await auth.refresh(res.refreshToken);
    assert.notEqual(r1.refreshToken, res.refreshToken);
    assert.ok(await auth.authenticate(r1.accessToken));

    // The phone never got r1 and retries with the token it still holds: new tokens, same session.
    advance(10);
    const r2 = await auth.refresh(res.refreshToken);
    assert.equal(await prisma.session.count({ where: { userId: res.user.id } }), 1);
    // r1 was superseded by the retry: unknown, but not treated as theft.
    await rejectsWith(auth.refresh(r1.refreshToken), INVALID_REFRESH_TOKEN);

    const r3 = await auth.refresh(r2.refreshToken);
    // r2 replayed after the grace window: theft. The whole session goes, r3 included.
    advance(REFRESH_RETRY_GRACE_SECONDS + 1);
    await rejectsWith(auth.refresh(r2.refreshToken), REFRESH_TOKEN_REUSED);
    assert.equal(await prisma.session.count({ where: { userId: res.user.id } }), 0);
    await rejectsWith(auth.refresh(r3.refreshToken), INVALID_REFRESH_TOKEN);
    assert.equal(await auth.authenticate(r3.accessToken), null, "revocation is immediate");
  });

  await check("refresh: two simultaneous refreshes of one token both succeed (no 500, no theft)", async () => {
    const res = await signIn(sub("e"), "install-e1");
    const [a, b] = await Promise.all([auth.refresh(res.refreshToken), auth.refresh(res.refreshToken)]);
    assert.notEqual(a.refreshToken, b.refreshToken);
    assert.equal(await prisma.session.count({ where: { userId: res.user.id } }), 1);
  });

  await check("refresh: a session unused for the idle window expires", async () => {
    const res = await signIn(sub("f"), "install-f1");
    advance(REFRESH_TOKEN_IDLE_DAYS * 86_400 + 1);
    await rejectsWith(auth.refresh(res.refreshToken), INVALID_REFRESH_TOKEN);
    assert.equal(await prisma.session.count({ where: { userId: res.user.id } }), 0);
  });

  await check("logout: signs the device out; an unknown token is silently fine", async () => {
    const res = await signIn(sub("g"), "install-g1");
    await auth.logout(res.refreshToken);
    assert.equal(await auth.authenticate(res.accessToken), null);
    await auth.logout("not-a-real-token-but-logout-must-not-say-so");
  });

  await check("devices: revoke one, revoke all others; someone else's session is a 404", async () => {
    const a = await signIn(sub("h"), "install-h1");
    const b = await signIn(sub("h"), "install-h2");
    const c = await signIn(sub("h"), "install-h3");
    const stranger = await signIn(sub("h-other"), "install-x1");

    await account.revokeSession(a.user.id, await sessionIdOf(c.accessToken));
    assert.equal(await auth.authenticate(c.accessToken), null);
    await rejectsWith(account.revokeSession(a.user.id, await sessionIdOf(stranger.accessToken)), "NOT_FOUND");

    const current = await sessionIdOf(a.accessToken);
    assert.deepEqual(await account.revokeOtherSessions(a.user.id, current), { revoked: 1 });
    assert.equal(await auth.authenticate(b.accessToken), null);
    assert.deepEqual((await account.listSessions(a.user.id, current)).map((s) => s.current), [true]);
  });

  await check("push token: moves to the session that registered it last; null clears it", async () => {
    const one = await signIn(sub("i1"), "install-shared");
    const two = await signIn(sub("i2"), "install-shared");
    const s1 = await sessionIdOf(one.accessToken);
    const s2 = await sessionIdOf(two.accessToken);
    await account.setPushToken(s1, "fcm-token-1");
    await account.setPushToken(s2, "fcm-token-1");
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: s1 } })).pushToken, null);
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: s2 } })).pushToken, "fcm-token-1");
    await account.setPushToken(s2, null);
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: s2 } })).pushToken, null);
  });

  await check("delete account: needs a fresh sign-in for the same Google account", async () => {
    const res = await signIn(sub("j"), "install-j1");
    const stale = Math.floor(clock.getTime() / 1000) - REAUTH_MAX_AGE_SECONDS - 1;
    await rejectsWith(account.deleteAccount(res.user.id, idTokenFor(sub("j"), stale)), "REAUTH_REQUIRED");
    await rejectsWith(account.deleteAccount(res.user.id, idTokenFor(sub("someone-else"))), "REAUTH_MISMATCH");
    await rejectsWith(account.deleteAccount(res.user.id, "garbage"), "REAUTH_REQUIRED");
    assert.ok(await auth.authenticate(res.accessToken), "nothing happened on a failed re-auth");
  });

  await check("delete account: anonymises the user, signs out every device; signing in again starts fresh", async () => {
    const phone = await signIn(sub("k"), "install-k1");
    const tablet = await signIn(sub("k"), "install-k2");
    await account.deleteAccount(phone.user.id, idTokenFor(sub("k")));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: phone.user.id } });
    assert.deepEqual(
      { googleSub: row.googleSub, email: row.email, name: row.name, photoUrl: row.photoUrl },
      { googleSub: null, email: null, name: null, photoUrl: null }
    );
    assert.ok(row.deletedAt);
    assert.equal(await prisma.session.count({ where: { userId: phone.user.id } }), 0);
    assert.equal(await auth.authenticate(tablet.accessToken), null);
    await rejectsWith(account.getProfile(phone.user.id), "NOT_FOUND");

    const again = await signIn(sub("k"), "install-k1");
    assert.equal(again.isNewUser, true);
    assert.notEqual(again.user.id, phone.user.id);
  });

  await cleanup();
  console.log(`\ncheck:auth-db — ${passed} checks passed`);
};

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
