import express from "express";
import cors from "cors";
import { config } from "./config/env";
import { requestLogger } from "./common/middleware/requestLogger";
import { optionalDevice } from "./common/middleware/device.middleware";
import { errorHandler } from "./common/errors/errorHandler";
import { NotFoundError } from "./common/errors/AppError";
import legalRoutes from "./modules/legal/legal.routes";
import remoteConfigRoutes from "./modules/remoteConfig/remoteConfig.routes";
import authRoutes from "./modules/auth/auth.routes";
import accountRoutes from "./modules/account/account.routes";
import { foldersRouter, nodesRouter, searchRouter, trashRouter } from "./modules/nodes/nodes.routes";
import syncRoutes from "./modules/sync/sync.routes";
import { filesRouter, uploadsRouter } from "./modules/files/files.routes";

const app = express();
app.disable("x-powered-by");
// nginx on the box is the one proxy in front of us: trust exactly one hop, so req.ip is the
// caller's address (rate limits key on it) rather than loopback.
app.set("trust proxy", 1);

// Global middleware
app.use(requestLogger); // registered first so it times everything
app.use(cors());
// Small JSON bodies only: file bytes never pass through this server — the app uploads straight
// to object storage with presigned URLs (docs/BACKEND_PLAN.md, deviation D2).
app.use(express.json({ limit: "1mb" }));
// X-Device-Id, when present and well-formed. Never rejects (see the middleware).
app.use(optionalDevice);

// Health check — the text protocol 05's deploy verification curls for.
app.get("/", (_req, res) => {
  res.type("text").send("BenchBox Backend Running");
});

// Public legal pages for the store listings and the app's own links (HOA protocol 12).
app.use(legalRoutes);

// Remote config: the app's first call on launch (HOA protocol 10). Nothing about the caller is
// required, and it never reads the database.
app.use("/config", remoteConfigRoutes);

// App API. Sign-in/refresh/logout are how a token is obtained; everything else requires one.
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/me", accountRoutes);
app.use("/api/v1/folders", foldersRouter);
app.use("/api/v1/nodes", nodesRouter);
app.use("/api/v1/trash", trashRouter);
app.use("/api/v1/search", searchRouter);
app.use("/api/v1/sync", syncRoutes);
app.use("/api/v1/uploads", uploadsRouter);
app.use("/api/v1/files", filesRouter);

// Unknown route -> standard 404 envelope, produced by the central error handler.
app.use((req) => {
  throw new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`);
});

// Centralized error handling — must be registered after all routes.
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`BenchBox backend listening on port ${config.port}`);
});
