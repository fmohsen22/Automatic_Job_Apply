import "dotenv/config";
import cors from "cors";
import express from "express";
import auditRoutes from "./routes/audit.js";
import cvRoutes from "./routes/cv.js";
import dashboardRoutes from "./routes/dashboard.js";
import jobRoutes from "./routes/jobs.js";
import modelRoutes from "./routes/models.js";
import settingsRoutes from "./routes/settings.js";

const app = express();
const port = Number(process.env.PORT || 4100);

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const healthHandler = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true, service: "automate-jobapply", milestone: "M2" });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.use("/api/audit", auditRoutes);
app.use("/api/cv", cvRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/settings", settingsRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err instanceof Error ? err.message : "Unexpected server error");
  res.status(400).json({ error: err instanceof Error ? err.message : "Unexpected server error" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});
