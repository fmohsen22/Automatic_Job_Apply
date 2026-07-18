import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { codexAvailability, CODEX_MODEL_ID } from "../services/codexProvider.js";
import { listOpenRouterModels, type OpenRouterModel } from "../services/openrouterModels.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

// Curated model combinations, kept in a plain JSON file so they can be
// re-researched and updated (new models, new prices) without touching code.
// Read fresh on every request — an edit shows up on the next click.
const PRESETS_PATH = path.resolve(process.cwd(), "server", "config", "model-presets.json");

router.get("/presets", asyncRoute(async (_req, res) => {
  const raw = await readFile(PRESETS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { updated?: string; presets?: unknown[] };
  res.json({ updated: parsed.updated || "", presets: parsed.presets || [] });
}));

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
