import { Router } from "express";
import { listTemplates, templatePreviewPath } from "../services/templates.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

router.get("/", asyncRoute(async (_req, res) => {
  res.json(listTemplates());
}));

// Pre-rendered gallery thumbnail. templatePreviewPath only resolves ids that
// exist in cvTemplates, so arbitrary paths can never reach the filesystem.
router.get("/:id/preview.png", asyncRoute(async (req, res) => {
  const file = templatePreviewPath(req.params.id);
  if (!file) {
    res.status(404).json({ error: "No preview available for this template" });
    return;
  }
  res.type("image/png");
  res.sendFile(file);
}));

export default router;
