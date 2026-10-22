// Base class for all expected/operational errors. Carries the HTTP status and a stable,
// machine-readable `code` that the error handler turns into the failure envelope
// { success: false, code, message }. BrimBox always sends a code: the app branches on it,
// never on the human-readable message.
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, message: string, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 400 — the request failed validation.
export class BadRequestError extends AppError {
  constructor(message = "Bad request", code = "BAD_REQUEST") {
    super(400, message, code);
  }
}

// 401 — missing or rejected authentication.
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code = "UNAUTHORIZED") {
    super(401, message, code);
  }
}

// 402 — the account needs billing set up first (e.g. storing more than the free allowance).
export class PaymentRequiredError extends AppError {
  constructor(message = "Payment required", code = "PAYMENT_REQUIRED") {
    super(402, message, code);
  }
}

// 403 — authenticated but not allowed (e.g. uploads while an account is read-only). Never used
// for someone else's row: that is a 404, so existence never leaks (HOA protocol 04).
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN") {
    super(403, message, code);
  }
}

// 404 — the resource does not exist, or isn't visible to this caller.
export class NotFoundError extends AppError {
  constructor(message = "Not found", code = "NOT_FOUND") {
    super(404, message, code);
  }
}

// 409 — the request conflicts with current state (e.g. a name already taken in a folder).
export class ConflictError extends AppError {
  constructor(message = "Conflict", code = "CONFLICT") {
    super(409, message, code);
  }
}

// 410 — what was asked for is gone for good (e.g. a sync cursor older than the retained history).
export class GoneError extends AppError {
  constructor(message = "Gone", code = "GONE") {
    super(410, message, code);
  }
}

// 413 — something the request declares is over a size limit (e.g. a file larger than allowed).
export class PayloadTooLargeError extends AppError {
  constructor(message = "Too large", code = "PAYLOAD_TOO_LARGE") {
    super(413, message, code);
  }
}

// 429 — the caller is over a rate limit. The error handler turns `retryAfterSeconds` into a
// Retry-After header.
export class TooManyRequestsError extends AppError {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = "Too many requests, please slow down") {
    super(429, message, "RATE_LIMITED");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// 503 — a feature is not configured or temporarily unavailable (e.g. an optional integration
// whose env vars are unset). Distinct from a 500 bug and a 400 client error.
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", code = "SERVICE_UNAVAILABLE") {
    super(503, message, code);
  }
}
