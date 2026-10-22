import { ServiceUnavailableError } from "../../../common/errors/AppError";
import { ObjectStore } from "../../../storage/objectStore";

// How the file services reach object storage during a request.

/** The store, or 503 while R2 isn't configured (an optional integration: its endpoints wait). */
export const requireStore = (store: ObjectStore | null): ObjectStore => {
  if (!store) throw new ServiceUnavailableError("File storage isn't available yet", "STORAGE_NOT_CONFIGURED");
  return store;
};

/**
 * A call to R2. If R2 fails or times out the request answers 503 STORAGE_UNAVAILABLE, which the app
 * retries, instead of a 500. The log line carries the error's name and message only — never a URL.
 */
export const storageCall = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[storage] R2 request failed: ${reason}`);
    throw new ServiceUnavailableError("File storage isn't responding. Try again in a moment.", "STORAGE_UNAVAILABLE");
  }
};
