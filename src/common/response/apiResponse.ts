import { Response } from "express";

// Standard API envelopes used across every endpoint (HOA protocol 04).
export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  // Stable, machine-readable code (e.g. NOT_FOUND, INVALID_JSON). Always present in BenchBox.
  code: string;
  message: string;
}

// Send a standard success response: { success: true, data: ... }.
// `data` defaults to {} for endpoints with no payload (e.g. deletes).
export const sendSuccess = <T>(res: Response, data?: T, status = 200): void => {
  res.status(status).json({ success: true, data: data ?? {} });
};
