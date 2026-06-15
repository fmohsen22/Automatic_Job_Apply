import { Router } from "express";
import { listTemplates } from "../services/templates.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

router.get("/", asyncRoute(async (_req, res) => {
  res.json(listTemplates());
}));

export default router;
