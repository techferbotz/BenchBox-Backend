import { DeepPartial } from "../../../common/deepMerge";

// ---------------------------------------------------------------------------
// The remote config document — the JSON the app reads at launch to decide how to behave
// (HOA protocol 10 §1).
//
// RULES FOR THIS SHAPE (they are what let it evolve without an app release):
//   - Every value is a JSON primitive, a nested object of them, or an array. No dates (use ISO
//     strings), no undefined (use null for "not set").
//   - ADDING a key is always safe: clients ignore keys they don't know and use their own
//     compiled-in default for keys that are missing. REMOVING or RENAMING a key breaks old
//     builds — bump SCHEMA_VERSION (remoteConfig.defaults.ts) and prefer adding a new key.
//   - Defaults equal today's behaviour, so an app that starts honouring the config changes
//     nothing until we deliberately flip a value.
//   - A number the server enforces is IMPORTED from the module that enforces it, never retyped.
// ---------------------------------------------------------------------------
export interface RemoteConfig {
  // Kill switches: client-side gates, true = on, every default true (protocol 10 §1). Turning one
  // off hides the entry point in the app; the API route itself keeps working. BrimBox adds one
  // switch per feature as that feature ships, each with a BE-nnn entry: `uploads` (BE-004).
  features: Record<string, boolean>;
  // Limits the server enforces, so the app can check before it starts (BE-004). Imported from the
  // module that enforces each one; uploads obey the RESOLVED value, so an override of one changes
  // the enforcement and what the app is told together.
  limits: {
    maxFileSizeBytes: number;
    maxThumbnailBytes: number;
  };
  // App update policy. The client compares its own integer BUILD number (the X-App-Build it
  // sends) — never the display version string, which does not sort reliably. 0 = no requirement.
  update: {
    minSupportedBuild: number; // below this: hard block, "update to continue"
    recommendedBuild: number; // below this: dismissible "update available" nudge
    androidStoreUrl: string | null;
    iosStoreUrl: string | null;
    message: string | null; // optional copy for either prompt
  };
  // Emergency switch: the app shows `message` instead of loading.
  maintenance: {
    enabled: boolean;
    message: string | null;
  };
  // Absolute URLs, so the app never hard-codes the API host for these (protocol 12).
  links: {
    privacyPolicy: string;
    terms: string;
    deleteAccount: string;
    supportEmail: string;
  };
}

// What GET /config returns (inside the standard envelope's `data`).
export interface RemoteConfigDto {
  schemaVersion: number; // bumped when keys are removed/renamed (additions do not bump it)
  variant: string; // "default", or "default+<ruleId>+..." for each targeting rule that applied
  revision: string; // fingerprint of `config` — changes whenever any value changes
  ttlSeconds: number; // re-fetch after this many seconds (and on every cold start)
  config: RemoteConfig;
}

// Who is asking. This is the targeting input for future rules — per-version, per-platform,
// per-device experiments (hash deviceId into buckets), per-user overrides. The optional fields
// come from headers the app sends (see remoteConfig.context.ts); a client that sends none
// still gets the default config.
export type Platform = "android" | "ios" | "web" | "unknown";

export interface ConfigContext {
  deviceId: string | null; // null = no X-Device-Id sent; such a caller can't be bucketed/targeted
  userId: string | null;
  platform: Platform;
  appVersion: string | null; // display version, e.g. "1.4.2" — for logs / rules that need it
  appBuild: number | null; // integer build number — what version rules should compare
}

// A targeting rule: when `matches(ctx)` is true, `patch` is deep-merged over the config.
// Rules apply in registry order (remoteConfig.rules.ts); a later rule wins on conflicts.
export interface ConfigRule {
  id: string; // short, stable, [a-z0-9-]; shows up in `variant` (and so in analytics)
  description: string; // why this rule exists, for the next reader
  matches: (ctx: ConfigContext) => boolean;
  patch: DeepPartial<RemoteConfig>;
}
