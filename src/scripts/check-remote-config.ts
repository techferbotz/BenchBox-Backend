// Fixture checks for the remote config module (HOA protocol 04: correctness fixtures as small
// ts-node scripts, no test framework). No database, no network:
//
//   npm run check:config
//
// Exercises the pieces a future rule / experiment will lean on: the strict merge, the header
// parsing, and the resolve order (defaults -> env overrides -> rules). Exits 1 on the first
// failed assertion. Adapted from HOA protocol 10's reference script.

// config/env.ts fails fast on missing REQUIRED vars. Set placeholders for any that are missing,
// BEFORE the imports below load env.ts (tsc keeps statement order in CommonJS output). dotenv never
// overrides a variable that is already set, so these placeholders win over a local .env.
for (const [key, value] of Object.entries({
  APP_PUBLIC_URL: "https://brimbox.ferbotz.com",
  DATABASE_URL: "postgresql://check:check@localhost:5432/check",
  JWT_SECRET: "check-placeholder-secret-at-least-32-characters",
})) {
  process.env[key] ??= value;
}

import assert from "node:assert/strict";
import { deepMergeStrict, MergeError } from "../common/deepMerge";
import { MAX_FILE_SIZE_BYTES, MAX_THUMBNAIL_BYTES } from "../modules/files/files.policy";
import { ConfigContext, ConfigRule } from "../modules/remoteConfig/dto/remoteConfig.dto";
import { DEFAULT_REMOTE_CONFIG, TTL_SECONDS } from "../modules/remoteConfig/remoteConfig.defaults";
import { parseContextHeaders } from "../modules/remoteConfig/remoteConfig.context";
import { RemoteConfigService } from "../modules/remoteConfig/service/remoteConfig.service";
import { RULES } from "../modules/remoteConfig/remoteConfig.rules";

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

const anon: ConfigContext = {
  deviceId: "device-1",
  userId: null,
  platform: "unknown",
  appVersion: null,
  appBuild: null,
};

// A first-launch caller that hasn't generated a device id yet — X-Device-Id is optional on /config.
const noDevice: ConfigContext = { ...anon, deviceId: null };

// ---------------------------------------------------------------- deepMergeStrict
check("merge: nested patch applies and inputs are not mutated", () => {
  const base = { a: { b: true, c: 1 }, d: "x" };
  const patch = { a: { b: false } };
  const out = deepMergeStrict(base, patch);
  assert.deepEqual(out, { a: { b: false, c: 1 }, d: "x" });
  assert.deepEqual(base, { a: { b: true, c: 1 }, d: "x" });
  assert.deepEqual(patch, { a: { b: false } });
});

check("merge: unknown key throws with the full path", () => {
  assert.throws(
    () => deepMergeStrict({ a: { b: true } }, { a: { bee: true } }, "X"),
    (e: unknown) => e instanceof MergeError && /X\.a\.bee: unknown key/.test((e as Error).message)
  );
});

check("merge: type mismatch throws", () => {
  assert.throws(() => deepMergeStrict({ a: true }, { a: "true" }), MergeError);
  assert.throws(() => deepMergeStrict({ a: 1 }, { a: { n: 1 } }), MergeError);
  assert.throws(() => deepMergeStrict({ a: { b: 1 } }, { a: 5 }), MergeError);
  assert.throws(() => deepMergeStrict({ a: 1 }, "not an object"), MergeError);
});

check("merge: null clears a primitive, never an object; a null base takes a primitive", () => {
  assert.deepEqual(deepMergeStrict({ a: "x" as string | null }, { a: null }), { a: null });
  assert.throws(() => deepMergeStrict({ a: { b: 1 } }, { a: null }), MergeError);
  assert.deepEqual(deepMergeStrict({ a: null as string | null }, { a: "now set" }), {
    a: "now set",
  });
  assert.throws(() => deepMergeStrict({ a: null }, { a: { b: 1 } }), MergeError);
});

check("merge: arrays are replaced wholesale", () => {
  assert.deepEqual(deepMergeStrict({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  assert.throws(() => deepMergeStrict({ a: [1] }, { a: "9" }), MergeError);
});

// ---------------------------------------------------------------- header parsing
check("context: well-formed headers parse", () => {
  const ctx = parseContextHeaders(
    { platform: "Android", version: "1.4.2", build: "1042" },
    { deviceId: "d", userId: "u" }
  );
  assert.deepEqual(ctx, {
    deviceId: "d",
    userId: "u",
    platform: "android",
    appVersion: "1.4.2",
    appBuild: 1042,
  });
});

check("context: missing or garbled headers degrade, never throw", () => {
  const ctx = parseContextHeaders(
    { platform: "windows-phone", version: "   ", build: "1.2" },
    { deviceId: "d", userId: null }
  );
  assert.deepEqual(ctx, {
    deviceId: "d",
    userId: null,
    platform: "unknown",
    appVersion: null,
    appBuild: null,
  });
  assert.equal(parseContextHeaders({}, { deviceId: "d", userId: null }).appBuild, null);
  assert.equal(parseContextHeaders({ build: "-5" }, { deviceId: "d", userId: null }).appBuild, null);
  // No identity at all is fine — X-Device-Id and the access token are both optional on /config.
  assert.deepEqual(parseContextHeaders({}, { deviceId: null, userId: null }), {
    deviceId: null,
    userId: null,
    platform: "unknown",
    appVersion: null,
    appBuild: null,
  });
});

// ---------------------------------------------------------------- defaults sanity
check("defaults: JSON-clean, day-one values (protocol 10 §1)", () => {
  const roundTrip = JSON.parse(JSON.stringify(DEFAULT_REMOTE_CONFIG));
  assert.deepEqual(roundTrip, DEFAULT_REMOTE_CONFIG);
  // Kill switches are all ON by default; turning one off is a deliberate act.
  for (const [key, on] of Object.entries(DEFAULT_REMOTE_CONFIG.features)) {
    assert.equal(on, true, `features.${key} must default to true`);
  }
  assert.equal(DEFAULT_REMOTE_CONFIG.update.minSupportedBuild, 0);
  assert.equal(DEFAULT_REMOTE_CONFIG.update.recommendedBuild, 0);
  assert.equal(DEFAULT_REMOTE_CONFIG.maintenance.enabled, false);
});

check("defaults: the limits the app is told are the ones the server enforces (imported, not retyped)", () => {
  assert.equal(DEFAULT_REMOTE_CONFIG.limits.maxFileSizeBytes, MAX_FILE_SIZE_BYTES);
  assert.equal(DEFAULT_REMOTE_CONFIG.limits.maxThumbnailBytes, MAX_THUMBNAIL_BYTES);
  assert.equal(DEFAULT_REMOTE_CONFIG.features.uploads, true);
  // An override changes the limit for everyone, and uploads obey the resolved value.
  const svc = new RemoteConfigService({
    defaults: DEFAULT_REMOTE_CONFIG,
    overrides: { limits: { maxFileSizeBytes: 5_000_000_000 } },
    rules: [],
  });
  assert.equal(svc.resolveConfig(anon).limits.maxFileSizeBytes, 5_000_000_000);
  assert.throws(
    () => new RemoteConfigService({ defaults: DEFAULT_REMOTE_CONFIG, overrides: { limits: { maxFileSizeBytes: "5GB" } }, rules: [] }),
    MergeError
  );
});

check("defaults: links are absolute https, plus a support address", () => {
  for (const [key, url] of Object.entries(DEFAULT_REMOTE_CONFIG.links)) {
    if (key === "supportEmail") assert.match(url, /^[^@\s]+@[^@\s]+$/);
    else assert.match(url, /^https:\/\/[^/]+\/[a-z-]+$/, `links.${key} must be absolute https`);
  }
});

// ---------------------------------------------------------------- resolution
check("resolve: no overrides, no rules -> the defaults, variant 'default'", () => {
  const svc = new RemoteConfigService({ defaults: DEFAULT_REMOTE_CONFIG, overrides: null, rules: [] });
  const dto = svc.resolve(anon);
  assert.equal(dto.variant, "default");
  assert.equal(dto.ttlSeconds, TTL_SECONDS);
  assert.match(dto.revision, /^[0-9a-f]{12}$/);
  assert.deepEqual(dto.config, DEFAULT_REMOTE_CONFIG);
  // Same input, same fingerprint.
  assert.equal(svc.resolve(anon).revision, dto.revision);
  // A caller with no device id gets exactly the same default.
  const bare = svc.resolve(noDevice);
  assert.equal(bare.variant, "default");
  assert.equal(bare.revision, dto.revision);
});

check("resolve: env overrides apply to everyone and change the revision", () => {
  const plain = new RemoteConfigService({ defaults: DEFAULT_REMOTE_CONFIG, overrides: null, rules: [] });
  const svc = new RemoteConfigService({
    defaults: DEFAULT_REMOTE_CONFIG,
    overrides: { maintenance: { enabled: true, message: "Back in 10 minutes" } },
    rules: [],
  });
  const dto = svc.resolve(anon);
  assert.equal(dto.variant, "default"); // overrides are the baseline, not a targeting variant
  assert.deepEqual(dto.config.maintenance, { enabled: true, message: "Back in 10 minutes" });
  assert.deepEqual(dto.config.update, DEFAULT_REMOTE_CONFIG.update); // untouched
  assert.notEqual(dto.revision, plain.resolve(anon).revision);
});

check("resolve: a bad override fails at construction (= startup), naming the path", () => {
  assert.throws(
    () =>
      new RemoteConfigService({
        defaults: DEFAULT_REMOTE_CONFIG,
        overrides: { features: { sharing: false } }, // no such switch (yet)
        rules: [],
      }),
    /REMOTE_CONFIG_OVERRIDES\.features\.sharing: unknown key/
  );
  assert.throws(
    () =>
      new RemoteConfigService({
        defaults: DEFAULT_REMOTE_CONFIG,
        overrides: { maintenance: { enabled: "true" } }, // string where a boolean lives
        rules: [],
      }),
    MergeError
  );
});

check("resolve: rules apply only when they match, in order, and show up in variant", () => {
  const legacyAndroid: ConfigRule = {
    id: "legacy-android-nudge",
    description: "old Android builds are nudged to update",
    matches: (ctx) => ctx.platform === "android" && ctx.appBuild !== null && ctx.appBuild < 100,
    patch: { update: { recommendedBuild: 100 } },
  };
  const tester: ConfigRule = {
    id: "qa-tester",
    description: "internal testers are never nudged and see a QA message",
    matches: (ctx) => ctx.userId === "qa-user",
    patch: { update: { recommendedBuild: 0, message: "QA build" } },
  };
  const bucketed: ConfigRule = {
    id: "exp-device-bucket",
    description: "example experiment arm — guard the null: no device id, no experiment",
    matches: (ctx) => ctx.deviceId !== null && ctx.deviceId.startsWith("a"),
    patch: { maintenance: { message: "experiment arm" } },
  };
  const svc = new RemoteConfigService({
    defaults: DEFAULT_REMOTE_CONFIG,
    overrides: null,
    rules: [legacyAndroid, tester, bucketed],
  });

  const nobody = svc.resolve(anon);
  assert.equal(nobody.variant, "default");
  assert.deepEqual(nobody.config, DEFAULT_REMOTE_CONFIG);

  // A device-bucketed rule never matches a caller without a device id.
  assert.equal(svc.resolve(noDevice).variant, "default");
  const inArm = svc.resolve({ ...anon, deviceId: "a1b2" });
  assert.equal(inArm.variant, "default+exp-device-bucket");
  assert.equal(inArm.config.maintenance.message, "experiment arm");

  const oldAndroid = svc.resolve({ ...anon, platform: "android", appBuild: 42 });
  assert.equal(oldAndroid.variant, "default+legacy-android-nudge");
  assert.equal(oldAndroid.config.update.recommendedBuild, 100);
  assert.equal(oldAndroid.config.update.minSupportedBuild, 0);

  const newAndroid = svc.resolve({ ...anon, platform: "android", appBuild: 100 });
  assert.equal(newAndroid.variant, "default");

  // Both match: the later rule wins on the conflicting key, and both ids are recorded.
  const both = svc.resolve({ ...anon, platform: "android", appBuild: 42, userId: "qa-user" });
  assert.equal(both.variant, "default+legacy-android-nudge+qa-tester");
  assert.equal(both.config.update.recommendedBuild, 0);
  assert.equal(both.config.update.message, "QA build");
  assert.notEqual(both.revision, nobody.revision);
});

check("resolveConfig: exactly the document resolve() serves, overrides and rules applied", () => {
  // Server code that must OBEY a value reads it through resolveConfig — so it has to be the very
  // document the app is handed, for every caller, or a switch could say one thing while the
  // server does another.
  const rule: ConfigRule = {
    id: "android-nudge",
    description: "",
    matches: (ctx) => ctx.platform === "android",
    patch: { update: { recommendedBuild: 7 } },
  };
  const svc = new RemoteConfigService({
    defaults: DEFAULT_REMOTE_CONFIG,
    overrides: { maintenance: { message: "Back soon" } },
    rules: [rule],
  });
  for (const ctx of [anon, noDevice, { ...anon, platform: "android" as const }]) {
    assert.deepEqual(svc.resolveConfig(ctx), svc.resolve(ctx).config);
  }
  assert.equal(svc.resolveConfig({ ...anon, platform: "android" }).update.recommendedBuild, 7);
  assert.equal(svc.resolveConfig(anon).maintenance.message, "Back soon");
});

check("resolve: duplicate or malformed rule ids are rejected at startup", () => {
  const rule: ConfigRule = { id: "dup", description: "", matches: () => false, patch: {} };
  assert.throws(
    () =>
      new RemoteConfigService({
        defaults: DEFAULT_REMOTE_CONFIG,
        overrides: null,
        rules: [rule, rule],
      }),
    /must be unique/
  );
  assert.throws(
    () =>
      new RemoteConfigService({
        defaults: DEFAULT_REMOTE_CONFIG,
        overrides: null,
        rules: [{ ...rule, id: "Not Valid" }],
      }),
    /must be unique and/
  );
});

check("resolve: the live RULES registry itself constructs cleanly", () => {
  const svc = new RemoteConfigService({ defaults: DEFAULT_REMOTE_CONFIG, overrides: null, rules: RULES });
  assert.equal(typeof svc.resolve(anon).revision, "string");
});

console.log(`\ncheck:config — ${passed} checks passed`);
