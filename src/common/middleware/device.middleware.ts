import { Request, Response, NextFunction } from "express";

// X-Device-Id is the app's stable per-install id (HOA protocols 10/11 — the experiment-bucketing
// key). BenchBox never requires it: identity is the user's token (from P1). It is attached when
// present and well-formed, and a garbled value is treated as absent — never a 400 — so that
// GET /config stays fetchable from any build in any state.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const optionalDevice = (req: Request, _res: Response, next: NextFunction): void => {
  const deviceId = req.header("X-Device-Id")?.trim();
  if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) {
    req.deviceId = deviceId;
  }
  next();
};
