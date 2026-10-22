import { Request, Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { rateLimit } from "../../common/middleware/rateLimit";
import { download, thumbnail } from "./controller/files.controller";
import { abortUpload, completeUpload, getUpload, partUrls, startUpload } from "./controller/uploads.controller";

// Uploads and downloads, as two routers mounted in app.ts. Limits are per account and generous: a
// phone backing up a camera roll starts hundreds of small uploads, and a photo grid asks for a
// thumbnail per tile. They exist to stop runaway loops, not people.

const perAccount = (req: Request): string => req.userId ?? req.ip ?? "-";

/** /api/v1/uploads */
export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);
uploadsRouter.post("/", rateLimit({ name: "upload-start", limit: 600, windowSeconds: 300, key: perAccount }), startUpload);
uploadsRouter.get("/:id", getUpload);
uploadsRouter.post("/:id/parts", rateLimit({ name: "upload-parts", limit: 1200, windowSeconds: 300, key: perAccount }), partUrls);
uploadsRouter.post("/:id/complete", completeUpload);
uploadsRouter.delete("/:id", abortUpload);

/** /api/v1/files */
export const filesRouter = Router();
filesRouter.use(requireAuth);
filesRouter.get("/:id/download", rateLimit({ name: "download", limit: 600, windowSeconds: 300, key: perAccount }), download);
filesRouter.get("/:id/thumbnail", rateLimit({ name: "thumbnail", limit: 3000, windowSeconds: 300, key: perAccount }), thumbnail);
