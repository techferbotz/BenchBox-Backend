import { Request, Response } from "express";
import { NotFoundError } from "../../../common/errors/AppError";
import { principalOf as principal } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import { isUuid, requireObjectBody, requireString } from "../../../common/validation";
import { accountService } from "../service/account.service";

// Thin controllers for /api/v1/me. Every route sits behind requireAuth.

// GET /api/v1/me
export const getMe = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, await accountService.getProfile(principal(req).userId));
};

// GET /api/v1/me/storage
export const getStorage = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, await accountService.storageUsage(principal(req).userId));
};

// DELETE /api/v1/me — { idToken } (a fresh Google sign-in for this account) → {}
export const deleteMe = async (req: Request, res: Response): Promise<void> => {
  const body = requireObjectBody(req.body);
  const idToken = requireString(body.idToken, "idToken", 4096);
  await accountService.deleteAccount(principal(req).userId, idToken);
  sendSuccess(res);
};

// GET /api/v1/me/sessions
export const listSessions = async (req: Request, res: Response): Promise<void> => {
  const { userId, sessionId } = principal(req);
  sendSuccess(res, await accountService.listSessions(userId, sessionId));
};

// DELETE /api/v1/me/sessions/:id — 404 for an unknown id or someone else's session
export const revokeSession = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principal(req);
  if (!isUuid(req.params.id)) throw new NotFoundError("Session not found");
  await accountService.revokeSession(userId, req.params.id);
  sendSuccess(res);
};

// POST /api/v1/me/sessions/revoke-others → { revoked }
export const revokeOtherSessions = async (req: Request, res: Response): Promise<void> => {
  const { userId, sessionId } = principal(req);
  sendSuccess(res, await accountService.revokeOtherSessions(userId, sessionId));
};

// PUT /api/v1/me/push-token — { token: string | null } → {}
export const setPushToken = async (req: Request, res: Response): Promise<void> => {
  const body = requireObjectBody(req.body);
  const token = body.token === null ? null : requireString(body.token, "token", 4096);
  await accountService.setPushToken(principal(req).sessionId, token);
  sendSuccess(res);
};
