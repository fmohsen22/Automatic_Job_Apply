import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { encryptSecret } from "../utils/crypto.js";
import { audit } from "../services/audit.js";
import { readSettings } from "../services/settings.js";

const router = Router();

const SettingsSchema = z.object({
  openaiApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  defaultCity: z.string().optional(),
  defaultAutonomyLevel: z.enum(["L0", "L1", "L2"]).default("L1"),
  defaultModel: z.string().optional(),
  searchProvider: z.enum(["openai", "openrouter"]).default("openai"),
  searchModel: z.string().optional(),
  tailorProvider: z.enum(["openai", "openrouter"]).default("openrouter"),
  tailorModel: z.string().optional()
});

const domains = {
  openaiApiKey: "api.openai.com",
  openrouterApiKey: "openrouter.ai",
  tavilyApiKey: "api.tavily.com"
};

router.get("/", async (_req, res) => {
  const [credentials, settings] = await Promise.all([prisma.credential.findMany(), readSettings()]);
  const hasCredential = (domain: string) => credentials.some((item: { domain: string }) => item.domain === domain);
  res.json({
    ...settings,
    openaiApiKeySet: hasCredential(domains.openaiApiKey) || Boolean(process.env.OPENAI_API_KEY),
    openrouterApiKeySet: hasCredential(domains.openrouterApiKey) || Boolean(process.env.OPENROUTER_API_KEY),
    tavilyApiKeySet: hasCredential(domains.tavilyApiKey) || Boolean(process.env.TAVILY_API_KEY)
  });
});

router.put("/", async (req, res) => {
  const parsed = SettingsSchema.parse(req.body);
  const writes = [
    ["openaiApiKey", domains.openaiApiKey],
    ["openrouterApiKey", domains.openrouterApiKey],
    ["tavilyApiKey", domains.tavilyApiKey]
  ] as const;

  for (const [field, domain] of writes) {
    const value = parsed[field];
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
    defaultModel: parsed.defaultModel || "gpt-5.5",
    searchProvider: parsed.searchProvider,
    searchModel: parsed.searchModel || parsed.defaultModel || "gpt-5.5",
    tailorProvider: parsed.tailorProvider,
    tailorModel: parsed.tailorModel || "anthropic/claude-sonnet-4.5"
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
      openaiApiKeySet: Boolean(parsed.openaiApiKey),
      openrouterApiKeySet: Boolean(parsed.openrouterApiKey),
      tavilyApiKeySet: Boolean(parsed.tavilyApiKey)
    }
  });

  res.json({ ok: true });
});

export default router;
