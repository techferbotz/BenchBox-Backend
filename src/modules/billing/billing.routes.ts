import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { getStatement, getSummary, getUsage, listStatements } from "./controller/billing.controller";

// /api/v1/billing — what the account is billed: this month so far and projected, daily usage, and
// the monthly statements. Read-only until P5 adds auto-pay.
const router = Router();
router.use(requireAuth);

router.get("/summary", getSummary);
router.get("/usage", getUsage);
router.get("/statements", listStatements);
router.get("/statements/:id", getStatement);

export default router;
