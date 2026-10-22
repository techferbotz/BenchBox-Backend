import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { rateLimit } from "../../common/middleware/rateLimit";
import {
  deleteMe,
  getMe,
  getStorage,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  setPushToken,
} from "./controller/account.controller";

// /api/v1/me — the signed-in user's account and devices.
const router = Router();
router.use(requireAuth);

router.get("/", getMe);
router.get("/storage", getStorage);
router.delete(
  "/",
  rateLimit({ name: "delete-account", limit: 10, windowSeconds: 3600, key: (req) => req.userId ?? req.ip ?? "-" }),
  deleteMe
);
router.get("/sessions", listSessions);
router.post("/sessions/revoke-others", revokeOtherSessions);
router.delete("/sessions/:id", revokeSession);
router.put("/push-token", setPushToken);

export default router;
