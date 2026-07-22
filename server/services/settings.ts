import { prisma } from "../db.js";

export const settingDefaults = {
  defaultCity: process.env.DEFAULT_CITY || "",
  defaultAutonomyLevel: process.env.DEFAULT_AUTONOMY_LEVEL || "L1",
  // Cheap/fast for search; creative Claude for tailoring; a cheap reviewer model
  // critiques the draft so the tailor model can refine it.
  searchModel: process.env.SEARCH_MODEL || "x-ai/grok-4.3",
  tailorModel: process.env.TAILOR_MODEL || "anthropic/claude-sonnet-4.5",
  reviewModel: process.env.REVIEW_MODEL || "openai/gpt-5.4-mini",
  applyModel: process.env.APPLY_MODEL || "anthropic/claude-sonnet-4.5",
  generalModel: process.env.GENERAL_MODEL || "anthropic/claude-sonnet-4.5"
};

export async function readSettings() {
  const rows = await prisma.appSetting.findMany();
  const values = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
  return { ...settingDefaults, ...values };
}
