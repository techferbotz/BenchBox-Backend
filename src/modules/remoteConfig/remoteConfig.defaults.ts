import { config } from "../../config/env";
import { MAX_FILE_SIZE_BYTES, MAX_THUMBNAIL_BYTES } from "../files/files.policy";
import { LEGAL_CONTACT_EMAIL, LEGAL_PATHS } from "../legal/legal.view";
import { RemoteConfig } from "./dto/remoteConfig.dto";

// Bump when a key is REMOVED or RENAMED (an old build may depend on it). Adding keys: no bump.
export const SCHEMA_VERSION = 1;

// How long the app may use a fetched config before asking again. It also re-fetches on every
// cold start, so a flipped switch reaches everyone within about an hour or one app restart.
export const TTL_SECONDS = 60 * 60;

// THE default config — what every app gets today. Where the server already has a constant for a
// value (legal URLs, support email; later upload limits and billing thresholds) it is IMPORTED,
// not retyped, so the number the app shows cannot drift from the number the server enforces.
//
// To change a value for everyone: edit here, deploy. To change it WITHOUT a deploy: set
// REMOTE_CONFIG_OVERRIDES in the server's .env (a JSON patch of this shape) and recreate the
// container — see docs/REMOTE_CONFIG.md. Per-version / per-user variations belong in
// remoteConfig.rules.ts, not here.
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  // One switch per feature as it ships (P7 adds sharing).
  features: {
    uploads: true,
  },
  limits: {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxThumbnailBytes: MAX_THUMBNAIL_BYTES,
  },
  update: {
    minSupportedBuild: 0,
    recommendedBuild: 0,
    // TODO: fill in once the store listing exists
    // (Play: https://play.google.com/store/apps/details?id=<applicationId>).
    androidStoreUrl: null,
    iosStoreUrl: null,
    message: null,
  },
  maintenance: {
    enabled: false,
    message: null,
  },
  // Built from the one configured origin + the legal module's own route paths and contact
  // address (HOA protocol 12), so a link here and the page it points at can never disagree.
  links: {
    privacyPolicy: `${config.appPublicUrl}${LEGAL_PATHS.privacy}`,
    terms: `${config.appPublicUrl}${LEGAL_PATHS.terms}`,
    deleteAccount: `${config.appPublicUrl}${LEGAL_PATHS.deleteAccount}`,
    supportEmail: LEGAL_CONTACT_EMAIL,
  },
};
