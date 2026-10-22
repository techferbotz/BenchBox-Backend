import { UserDto } from "../../account/dto/account.dto";

// Request/response shapes for /api/v1/auth. The token half (refresh, logout) says nothing about
// Google, so Sign in with Apple later is one new request and one new verifier.

/** Where a sign-in comes from — hints for the "signed-in devices" list, never trusted for security. */
export interface DeviceInfo {
  deviceId: string | null; // X-Device-Id: one session per install
  deviceName: string | null; // e.g. "Pixel 8", from the request body
  platform: string | null; // X-App-Platform
  appVersion: string | null; // X-App-Version
}

export interface TokenPairResponse {
  accessToken: string;
  // Access-token lifetime in SECONDS, so the app can refresh ahead of expiry instead of waiting
  // for a 401. Relative, so device clock skew doesn't matter.
  expiresIn: number;
  // The raw refresh token — returned exactly once. Only its hash is stored, so it can never be
  // shown again; the app must keep it in encrypted storage. Every refresh returns a NEW one.
  refreshToken: string;
}

export interface SignInResponse extends TokenPairResponse {
  user: UserDto;
  // True the first time this Google account signs in to BenchBox.
  isNewUser: boolean;
}
