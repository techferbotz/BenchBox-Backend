import { Request, Response } from "express";
import { BadRequestError, NotFoundError } from "../../../common/errors/AppError";
import { principalOf } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import {
  isUuid,
  optionalEnum,
  optionalParentId,
  requireNonNegativeInt,
  requireObjectBody,
  requireUuid,
} from "../../../common/validation";
import { contextFromRequest } from "../../remoteConfig/remoteConfig.context";
import { remoteConfigService } from "../../remoteConfig/service/remoteConfig.service";
import { OnUploadConflict } from "../dto/upload.dto";
import { uploadsService } from "../service/uploads.service";

// Thin controllers for /api/v1/uploads. Every route sits behind requireAuth.

const CONFLICT_POLICIES: readonly OnUploadConflict[] = ["fail", "rename", "replace"];

// An upload id in the path. A malformed one can't name anything: 404, like a missing one.
const uploadIdParam = (req: Request<{ id: string }>): string => {
  if (!isUuid(req.params.id)) throw new NotFoundError("Upload not found");
  return req.params.id.toLowerCase();
};

// Bodies are optional on some routes: no body at all is the same as {}.
const optionalBody = (body: unknown): Record<string, unknown> => (body === undefined ? {} : requireObjectBody(body));

// "thumbnail": { "size": n } when the app will PUT a thumbnail; absent or null when it won't.
const thumbnailSize = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError('"thumbnail" must be an object like {"size": 12345}, or null');
  }
  return requireNonNegativeInt((value as Record<string, unknown>).size, "thumbnail.size");
};

// POST /api/v1/uploads — { id, fileId, parentId?, name, size, mimeType?, onConflict?, thumbnail? }
// → 201 (200 when this upload id already exists)
export const startUpload = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const body = requireObjectBody(req.body);
  const { upload, created } = await uploadsService.start(
    userId,
    {
      id: requireUuid(body.id, "id"),
      fileId: requireUuid(body.fileId, "fileId"),
      parentId: optionalParentId(body.parentId) ?? null,
      name: body.name,
      size: requireNonNegativeInt(body.size, "size"),
      mimeType: body.mimeType,
      onConflict: optionalEnum(body.onConflict, "onConflict", CONFLICT_POLICIES, "fail"),
      thumbnailSize: thumbnailSize(body.thumbnail),
    },
    // The limit the app is told in GET /config is the limit enforced (protocol 10 §2).
    remoteConfigService.resolveConfig(contextFromRequest(req)).limits.maxFileSizeBytes
  );
  sendSuccess(res, upload, created ? 201 : 200);
};

// GET /api/v1/uploads/:id — the upload as it stands (resume)
export const getUpload = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await uploadsService.get(userId, uploadIdParam(req)));
};

// POST /api/v1/uploads/:id/parts — { partNumbers: [1, 2, …] } → { parts }
export const partUrls = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const id = uploadIdParam(req);
  const body = requireObjectBody(req.body);
  sendSuccess(res, await uploadsService.partUrls(userId, id, body.partNumbers));
};

// POST /api/v1/uploads/:id/complete — { onConflict? } → the upload, with its file
export const completeUpload = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const id = uploadIdParam(req);
  const body = optionalBody(req.body);
  const onConflict =
    body.onConflict === undefined ? undefined : optionalEnum(body.onConflict, "onConflict", CONFLICT_POLICIES, "fail");
  sendSuccess(res, await uploadsService.complete(userId, id, onConflict));
};

// DELETE /api/v1/uploads/:id — cancel → {}
export const abortUpload = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  await uploadsService.abort(userId, uploadIdParam(req));
  sendSuccess(res);
};
