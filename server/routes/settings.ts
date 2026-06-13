import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { encryptSecret } from "../utils/crypto.js";
import { audit } from "../services/audit.js";

const router = Router();

const SettingsSchema = z.object({
  openaiApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  defaultCity: z.string().optional(),
  defaultAutonomyLevel: z.enum(["L0", "L1", "L2"]).default("L1"),
  defaultModel: z.string().optional()
});

const domains = {
  openaiApiKey: "api.openai.com",
  tavilyApiKey: "api.tavily.com"
};

router.get("/", async (_req, res) => {
  const credentials = await prisma.credential.findMany();
  const hasCredential = (domain: string) => credentials.some((item: { domain: string }) => item.domain === domain);
  res.json({
    defaultCity: process.env.DEFAULT_CITY || "",
    defaultAutonomyLevel: process.env.DEFAULT_AUTONOMY_LEVEL || "L1",
    defaultModel: process.env.DEFAULT_MODEL || "gpt-4.1",
    openaiApiKeySet: hasCredential(domains.openaiApiKey) || Boolean(process.env.OPENAI_API_KEY),
    tavilyApiKeySet: hasCredential(domains.tavilyApiKey) || Boolean(process.env.TAVILY_API_KEY)
  });
});

router.put("/", async (req, res) => {
  const parsed = SettingsSchema.parse(req.body);
  const writes = [
    ["openaiApiKey", domains.openaiApiKey],
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

  await audit("settings.updated", "Settings updated", {
    entity: "settings",
    metadata: {
      defaultCity: parsed.defaultCity,
      defaultAutonomyLevel: parsed.defaultAutonomyLevel,
      defaultModel: parsed.defaultModel,
      openaiApiKeySet: Boolean(parsed.openaiApiKey),
      tavilyApiKeySet: Boolean(parsed.tavilyApiKey)
    }
  });

  res.json({ ok: true });
});

export default router;
