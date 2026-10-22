import { Request, Response } from "express";
import { NotFoundError } from "../../../common/errors/AppError";
import { principalOf } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import { isUuid } from "../../../common/validation";
import { filesService } from "../service/files.service";

// Thin controllers for /api/v1/files. Every route sits behind requireAuth.

const fileIdParam = (req: Request<{ id: string }>): string => {
  if (!isUuid(req.params.id)) throw new NotFoundError("File not found");
  return req.params.id.toLowerCase();
};

// GET /api/v1/files/:id/download → { url, expiresAt }
export const download = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await filesService.download(userId, fileIdParam(req)));
};

// GET /api/v1/files/:id/thumbnail → 302 to the image. A stable URL per file, so the app's image
// loader can request it with its bearer token and cache the image by `contentId`; the redirect
// to R2 carries no token (HTTP clients drop Authorization when the host changes).
export const thumbnail = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const url = await filesService.thumbnailUrl(userId, fileIdParam(req));
  res.set("Cache-Control", "private, max-age=3000"); // inside the URL's own hour
  res.redirect(302, url);
};
