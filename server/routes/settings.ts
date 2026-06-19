import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { encryptSecret } from "../utils/crypto.js";
import { audit } from "../services/audit.js";
import { getSecret } from "../services/secrets.js";
import { readSettings } from "../services/settings.js";

const router = Router();

const SettingsSchema = z.object({
  openrouterApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  defaultCity: z.string().optional(),
  defaultAutonomyLevel: z.enum(["L0", "L1", "L2"]).default("L1"),
  searchModel: z.string().optional(),
  tailorModel: z.string().optional(),
  reviewModel: z.string().optional(),
  applyModel: z.string().optional(),
  generalModel: z.string().optional()
});

const domains = {
  openrouterApiKey: "openrouter.ai",
  tavilyApiKey: "api.tavily.com"
};

router.get("/", async (_req, res) => {
  const [credentials, settings] = await Promise.all([prisma.credential.findMany(), readSettings()]);
  const hasCredential = (domain: string) => credentials.some((item: { domain: string }) => item.domain === domain);
  res.json({
    ...settings,
    openrouterApiKeySet: hasCredential(domains.openrouterApiKey) || Boolean(process.env.OPENROUTER_API_KEY),
    openrouterApiKeyStored: hasCredential(domains.openrouterApiKey),
    tavilyApiKeySet: hasCredential(domains.tavilyApiKey) || Boolean(process.env.TAVILY_API_KEY),
    tavilyApiKeyStored: hasCredential(domains.tavilyApiKey)
  });
});

router.put("/", async (req, res) => {
  const parsed = SettingsSchema.parse(req.body);
  const writes = [
    ["openrouterApiKey", domains.openrouterApiKey],
    ["tavilyApiKey", domains.tavilyApiKey]
  ] as const;

  for (const [field, domain] of writes) {
    const value = parsed[field]?.trim();
    if (value) {
      await prisma.credential.upsert({
        where: { domain },
        update: { encrypted: encryptSecret(value) },
        create: { domain, encrypted: encryptSecret(value) }
      });
    }
  }

  const appSettings = {
    defaultCity: parsed.defaultCity || "",
    defaultAutonomyLevel: parsed.defaultAutonomyLevel,
    searchModel: parsed.searchModel || "x-ai/grok-4.3",
    tailorModel: parsed.tailorModel || "anthropic/claude-sonnet-4.5",
    reviewModel: parsed.reviewModel || "",
    applyModel: parsed.applyModel || parsed.tailorModel || "anthropic/claude-sonnet-4.5",
    generalModel: parsed.generalModel || parsed.tailorModel || "anthropic/claude-sonnet-4.5"
  };

  await prisma.$transaction(
    Object.entries(appSettings).map(([key, value]) =>
      prisma.appSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value }
      })
    )
  );

  await audit("settings.updated", "Settings updated", {
    entity: "settings",
    metadata: {
      ...appSettings,
      openrouterApiKeySet: Boolean(parsed.openrouterApiKey),
      tavilyApiKeySet: Boolean(parsed.tavilyApiKey)
    }
  });

  res.json({ ok: true });
});

router.post("/test-openrouter", async (_req, res) => {
  const apiKey = await getSecret(domains.openrouterApiKey, process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    res.status(400).json({ error: "OpenRouter API key is not saved." });
    return;
  }

  const response = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "http://127.0.0.1:4173",
      "X-Title": "Automate JobApply"
    }
  });
  const text = await response.text();

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = payload.error?.message || payload.message || message;
    } catch {
      if (text) message = text.slice(0, 240);
    }
    res.status(400).json({ error: `OpenRouter rejected the saved key: ${message}` });
    return;
  }

  let credits: unknown = null;
  try {
    credits = JSON.parse(text);
  } catch {
    credits = "available";
  }

  res.json({ ok: true, message: "OpenRouter key is valid.", credits });
});

export default router;
