import { ConfigRule } from "./dto/remoteConfig.dto";

// Targeting rules, in the order they apply. EMPTY today: every caller gets the default config
// (plus any REMOTE_CONFIG_OVERRIDES from the environment). This array is the seam for:
//
//   - a per-version config, e.g.
//       matches: (ctx) => ctx.platform === "android" && ctx.appBuild !== null && ctx.appBuild < 120,
//       patch:   { update: { recommendedBuild: 120 } }          // nudge old builds to update
//   - an experiment: bucket DETERMINISTICALLY on the device so an install stays in one arm across
//     launches — e.g. `ctx.deviceId !== null && bucketOf(ctx.deviceId, "uploader-2026-11") < 50`,
//     where bucketOf hashes (deviceId + experiment key) to 0..99. X-Device-Id is OPTIONAL on
//     /config, so guard the null: a caller without a device id is never in an experiment. The
//     rule id lands in `variant`, which is what analytics uses to tell the arms apart.
//   - a per-user override for QA / internal testers: matches: (ctx) => ctx.userId === "<id>".
//
// TO ADD A RULE: write it below and add it to RULES — nothing else changes. Patches are typed
// against RemoteConfig, so a wrong key or type is a compile error, and every patch is also
// validated against the defaults at startup. Rules must be pure and fast: this runs on every
// app launch and MUST NOT hit the database. (A DB-backed rule set is a future step — load the
// rows into this array on startup / on an interval, never per request.)
// (Verbatim from HOA protocol 10's reference implementation, with BenchBox examples.)
export const RULES: ConfigRule[] = [];
