import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { prisma } from "./db.js";
import auditRoutes from "./routes/audit.js";
import cvRoutes from "./routes/cv.js";
import dashboardRoutes from "./routes/dashboard.js";
import docSetRoutes from "./routes/docsets.js";
import jobRoutes from "./routes/jobs.js";
import modelRoutes from "./routes/models.js";
import settingsRoutes from "./routes/settings.js";
import templateRoutes from "./routes/templates.js";

const app = express();
const port = Number(process.env.PORT || 4100);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(dirname, "../web");

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const healthHandler = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true, service: "automate-jobapply", milestone: "M2" });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.use("/api/audit", auditRoutes);
app.use("/api/cv", cvRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/docsets", docSetRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/templates", templateRoutes);

if (existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDir, "index.html"));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err instanceof Error ? err.message : "Unexpected server error");
  res.status(400).json({ error: err instanceof Error ? err.message : "Unexpected server error" });
});

// A search that was mid-flight when the server stopped can't still be running —
// reset any leftover RUNNING runs so they don't show "running forever".
prisma.searchRun
  .updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED" } })
  .then((result) => {
    if (result.count) console.log(`Reset ${result.count} interrupted search run(s).`);
  })
  .catch(() => {});

app.listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});
