import OpenAI from "openai";
import { prisma } from "../db.js";
import { decryptSecret } from "../utils/crypto.js";

export type LlmProviderId = "openai" | "openrouter";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  provider: LlmProviderId;
  model: string;
  messages: LlmMessage[];
  responseFormat?: "text" | "json";
}

const credentialDomains: Record<LlmProviderId, string> = {
  openai: "api.openai.com",
  openrouter: "openrouter.ai"
};

async function getApiKey(provider: LlmProviderId) {
  const envKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  const credential = await prisma.credential.findUnique({
    where: { domain: credentialDomains[provider] }
  });
  if (!credential) {
    throw new Error(`Missing ${provider} API key. Add it in Settings.`);
  }

  return decryptSecret(credential.encrypted);
}

export async function createLlmClient(provider: LlmProviderId) {
  const apiKey = await getApiKey(provider);

  if (provider === "openrouter") {
    return new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "http://127.0.0.1:5173",
        "X-Title": "Automate JobApply"
      }
    });
  }

  return new OpenAI({ apiKey });
}

export async function runLlm(request: LlmRequest) {
  const client = await createLlmClient(request.provider);
  const response = await client.chat.completions.create({
    model: request.model,
    messages: request.messages,
    response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined
  });

  return response.choices[0]?.message?.content || "";
}
