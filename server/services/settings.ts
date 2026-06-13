import { prisma } from "../db.js";

export const settingDefaults = {
  defaultCity: process.env.DEFAULT_CITY || "",
  defaultAutonomyLevel: process.env.DEFAULT_AUTONOMY_LEVEL || "L1",
  searchModel: process.env.SEARCH_MODEL || "",
  tailorModel: process.env.TAILOR_MODEL || "anthropic/claude-sonnet-4.5",
  applyModel: process.env.APPLY_MODEL || "anthropic/claude-sonnet-4.5",
  generalModel: process.env.GENERAL_MODEL || "anthropic/claude-sonnet-4.5"
};

export async function readSettings() {
  const rows = await prisma.appSetting.findMany();
  const values = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
  return { ...settingDefaults, ...values };
}
