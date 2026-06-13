import { Router } from "express";
import { listOpenRouterModels } from "../services/openrouterModels.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

router.get("/openrouter", asyncRoute(async (_req, res) => {
  const models = await listOpenRouterModels();
  res.json(models);
}));

export default router;
