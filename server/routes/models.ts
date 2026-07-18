import { Router } from "express";
import { codexAvailability, CODEX_MODEL_ID } from "../services/codexProvider.js";
import { listOpenRouterModels, type OpenRouterModel } from "../services/openrouterModels.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

router.get("/openrouter", asyncRoute(async (_req, res) => {
  // The Codex pseudo-model (user's ChatGPT plan via the local Codex CLI) is
  // always listed first — even when the OpenRouter list can't be fetched.
  const codex = await codexAvailability();
  const codexModel: OpenRouterModel = {
    id: CODEX_MODEL_ID,
    name: "Codex — your ChatGPT plan",
    category: "general",
    local: true,
    available: codex.available,
    unavailableReason: codex.reason
  };

  let models: OpenRouterModel[] = [];
  try {
    models = await listOpenRouterModels();
  } catch {
    // No OpenRouter key / network issue — still offer Codex.
  }

  res.json([codexModel, ...models]);
}));

export default router;
