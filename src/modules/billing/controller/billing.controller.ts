import { Request, Response } from "express";
import { principalOf } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import { billingService } from "../service/billing.service";

// Thin controllers for /api/v1/billing. Every route sits behind requireAuth.

// GET /api/v1/billing/summary
export const getSummary = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, await billingService.summary(principalOf(req).userId));
};

// GET /api/v1/billing/usage?from=YYYY-MM-DD&to=YYYY-MM-DD
export const getUsage = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, await billingService.usage(principalOf(req).userId, req.query.from, req.query.to));
};

// GET /api/v1/billing/statements?cursor&limit
export const listStatements = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, await billingService.listStatements(principalOf(req).userId, req.query.cursor, req.query.limit));
};

// GET /api/v1/billing/statements/:id
export const getStatement = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  sendSuccess(res, await billingService.getStatement(principalOf(req).userId, req.params.id));
};
