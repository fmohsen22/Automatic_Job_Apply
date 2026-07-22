import { getSecret } from "./secrets.js";

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
  category: "search" | "tailor" | "apply" | "general";
  // Set on the local "codex" pseudo-model only.
  local?: boolean;
  available?: boolean;
  unavailableReason?: string;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
  }>;
}

export async function listOpenRouterModels() {
  const apiKey = await getSecret("openrouter.ai", process.env.OPENROUTER_API_KEY);
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OpenRouter models failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenRouterModelsResponse;
  return (body.data ?? [])
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      contextLength: model.context_length,
      promptPrice: model.pricing?.prompt,
      completionPrice: model.pricing?.completion,
      category: inferCategory(model.id, model.pricing?.prompt, model.pricing?.completion)
    }))
    .sort((left, right) => modelRank(left.category, left.id) - modelRank(right.category, right.id));
}

function inferCategory(id: string, promptPrice?: string, completionPrice?: string): "search" | "tailor" | "apply" | "general" {
  const lower = id.toLowerCase();
  if (
    lower.includes("fast") ||
    lower.includes("flash") ||
    lower.includes("mini") ||
    lower.includes("nano") ||
    lower.includes("haiku") ||
    lower.includes("lite") ||
    lower.includes("grok") ||
    isCheap(promptPrice, completionPrice)
  ) {
    return "search";
  }

  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("gpt-5.5") || lower.includes("gpt-5-pro")) {
    return "tailor";
  }

  if (lower.includes("deepseek") || lower.includes("qwen") || lower.includes("gemini")) {
    return "apply";
  }

  return "general";
}

function isCheap(promptPrice?: string, completionPrice?: string) {
  const prompt = Number(promptPrice ?? "1");
  const completion = Number(completionPrice ?? "1");
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt <= 0.0000015 && completion <= 0.00001;
}

function modelRank(category: "search" | "tailor" | "apply" | "general", id: string) {
  const lower = id.toLowerCase();
  const base = { search: 0, tailor: 100, apply: 200, general: 300 }[category];
  if (lower === "anthropic/claude-sonnet-4.5") return base;
  if (lower.includes("grok") && lower.includes("fast")) return base + 1;
  if (lower.includes("flash") || lower.includes("mini") || lower.includes("nano") || lower.includes("haiku")) return base + 2;
  if (lower.includes("claude") && lower.includes("sonnet")) return base + 3;
  if (lower.includes("claude")) return base + 4;
  if (lower.includes("gpt")) return base + 5;
  return base + 50;
}
