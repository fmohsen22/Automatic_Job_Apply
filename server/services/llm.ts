import OpenAI from "openai";
import { getSecret } from "./secrets.js";
import { isCodexModel, runCodex } from "./codexProvider.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  responseFormat?: "text" | "json";
  maxTokens?: number;
}

async function getApiKey() {
  const apiKey = await getSecret("openrouter.ai", process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error("Missing OpenRouter API key. Add it in Settings.");
  }

  return apiKey;
}

export async function createLlmClient() {
  const apiKey = await getApiKey();
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "http://127.0.0.1:4173",
      "X-Title": "Automate JobApply"
    }
  });
}

export async function runLlm(request: LlmRequest) {
  // "codex" routes through the local Codex CLI (the user's ChatGPT plan)
  // instead of OpenRouter.
  if (isCodexModel(request.model)) {
    return runCodex(request.messages, { responseFormat: request.responseFormat });
  }

  const client = await createLlmClient();
  const response = await client.chat.completions.create({
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined
  });

  return response.choices[0]?.message?.content || "";
}
