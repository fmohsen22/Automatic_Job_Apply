import { prisma } from "../db.js";

export const settingDefaults = {
  defaultCity: process.env.DEFAULT_CITY || "",
  defaultAutonomyLevel: process.env.DEFAULT_AUTONOMY_LEVEL || "L1",
  defaultModel: process.env.DEFAULT_MODEL || "gpt-5.5",
  searchProvider: process.env.SEARCH_LLM_PROVIDER || "openai",
  searchModel: process.env.SEARCH_MODEL || process.env.DEFAULT_MODEL || "gpt-5.5",
  tailorProvider: process.env.TAILOR_LLM_PROVIDER || "openrouter",
  tailorModel: process.env.TAILOR_MODEL || "anthropic/claude-sonnet-4.5"
};

export async function readSettings() {
  const rows = await prisma.appSetting.findMany();
  const values = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
  return { ...settingDefaults, ...values };
}
