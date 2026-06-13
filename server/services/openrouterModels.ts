import { getSecret } from "./secrets.js";

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
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

const preferredModelTerms = ["claude", "gpt", "gemini", "deepseek", "qwen", "llama", "mistral"];

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
    .filter((model) => preferredModelTerms.some((term) => model.id.toLowerCase().includes(term)))
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      contextLength: model.context_length,
      promptPrice: model.pricing?.prompt,
      completionPrice: model.pricing?.completion
    }))
    .sort((left, right) => modelRank(left.id) - modelRank(right.id))
    .slice(0, 80);
}

function modelRank(id: string) {
  const lower = id.toLowerCase();
  if (lower === "anthropic/claude-sonnet-4.5") return 0;
  if (lower.includes("claude") && lower.includes("sonnet")) return 1;
  if (lower.includes("claude")) return 2;
  if (lower.includes("gpt-5")) return 3;
  if (lower.includes("gemini")) return 4;
  return 10;
}
