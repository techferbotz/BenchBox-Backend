import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { AppError, TooManyRequestsError } from "./AppError";
import { ErrorResponse } from "../response/apiResponse";

// express.json() errors carry a `type`; these are the two a client can cause.
const bodyParserErrorType = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
};

// Every other body express.json() can't read — a corrupt compressed stream, bytes trailing it
// (body-parser ≥ 2.4 refuses them, GHSA-27r3-jxmh-p828), an unsupported encoding or charset — comes
// as an http-errors client error: `expose: true` and a 4xx status, sometimes with no `type`.
const isClientBodyError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const { expose, status } = err as { expose?: unknown; status?: unknown };
  return expose === true && typeof status === "number" && status >= 400 && status < 500;
};

// Centralized error handler — the only place a failure response is written (HOA protocol 04).
// Must be registered after all routes; Express recognises it by its four parameters. Express 5
// forwards rejected promises from async handlers here, so controllers need no try/catch.
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  // A response that already started streaming can't be replaced; let Express close it.
  if (res.headersSent) {
    next(err);
    return;
  }

  const fail = (status: number, code: string, message: string): void => {
    const body: ErrorResponse = { success: false, code, message };
    res.status(status).json(body);
  };

  if (err instanceof AppError) {
    if (err instanceof TooManyRequestsError) {
      res.set("Retry-After", String(err.retryAfterSeconds));
    }
    fail(err.statusCode, err.code, err.message);
    return;
  }

  const parserType = bodyParserErrorType(err);
  if (parserType === "entity.parse.failed") {
    fail(400, "INVALID_JSON", "Invalid JSON body");
    return;
  }
  if (parserType === "entity.too.large") {
    fail(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    return;
  }
  // The client's mistake, not ours: a 400 rather than a 500 with a stack in the log.
  if (isClientBodyError(err)) {
    fail(400, "BAD_REQUEST", "The request body could not be read");
    return;
  }

  // Prisma errors a request can legitimately trigger, mapped to the codes the app understands.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      fail(404, "NOT_FOUND", "Not found");
      return;
    }
    if (err.code === "P2002") {
      fail(409, "CONFLICT", "Already exists");
      return;
    }
  }

  // Anything else is unexpected: log it (never request bodies or headers) and return 500.
  console.error(err);
  fail(500, "INTERNAL", "Internal server error");
};
