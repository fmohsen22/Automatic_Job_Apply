import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { audit } from "../services/audit.js";
import { rankJob } from "../services/jobRanking.js";
import { readSettings } from "../services/settings.js";
import { searchTavily, type TavilyResult } from "../services/tavily.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

const JobSearchSchema = z.object({
  role: z.string().min(2),
  city: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).default(10)
});

router.get("/", asyncRoute(async (_req, res) => {
  const jobs = await prisma.job.findMany({ orderBy: [{ fitScore: "desc" }, { updatedAt: "desc" }] });
  res.json(jobs.map(presentJob));
}));

router.post("/search", asyncRoute(async (req, res) => {
  const parsed = JobSearchSchema.parse(req.body);
  const [settings, latestCv] = await Promise.all([
    readSettings(),
    prisma.cvVersion.findFirst({ orderBy: { createdAt: "desc" } })
  ]);

  const profile = await prisma.jobProfile.create({
    data: {
      city: parsed.city,
      roles: parsed.role,
      filters: toJsonString({ maxResults: parsed.maxResults })
    }
  });

  await audit("jobs.search.started", `Searching ${parsed.role} jobs in ${parsed.city}`, {
    entity: "JobProfile",
    entityId: profile.id,
    metadata: { source: "tavily", maxResults: parsed.maxResults }
  });

  const tavily = await searchTavily(parsed);
  const normalized = dedupeByUrl(tavily.results.map((result) => normalizeJob(result, parsed.city)));
  const cv = latestCv ? fromJsonString(latestCv.json, {}) : {};
  const ranked = [];

  for (const job of normalized) {
    const ranking = await rankJob({
      cv,
      title: job.title,
      company: job.company,
      description: job.descr,
      fallbackScore: job.fallbackScore,
      model: settings.searchModel || "google/gemini-2.5-flash-lite"
    });

    const saved = await prisma.job.upsert({
      where: { url: job.url },
      update: {
        source: job.source,
        company: job.company,
        title: job.title,
        location: job.location,
        descr: job.descr,
        fitScore: ranking.score,
        fitReasons: toJsonString(ranking.reasons)
      },
      create: {
        source: job.source,
        url: job.url,
        company: job.company,
        title: job.title,
        location: job.location,
        descr: job.descr,
        fitScore: ranking.score,
        fitReasons: toJsonString(ranking.reasons)
      }
    });
    ranked.push(presentJob(saved));
  }

  ranked.sort((a, b) => b.fitScore - a.fitScore);

  await audit("jobs.search.completed", `Found ${ranked.length} jobs for ${parsed.role} in ${parsed.city}`, {
    entity: "JobProfile",
    entityId: profile.id,
    metadata: {
      tavilyResults: tavily.results.length,
      savedJobs: ranked.length,
      rankingProvider: "openrouter",
      rankingModel: settings.searchModel || "google/gemini-2.5-flash-lite"
    }
  });

  res.json({ jobs: ranked, profileId: profile.id });
}));

function normalizeJob(result: TavilyResult, city: string) {
  const url = result.url.trim();
  const title = result.title.trim();
  const company = inferCompany(title, url);
  const description = [result.content, result.raw_content].filter(Boolean).join("\n\n").slice(0, 6000);
  return {
    source: "tavily",
    url,
    company,
    title: cleanTitle(title, company),
    location: city,
    descr: description || title,
    fallbackScore: Math.round((result.score ?? 0.5) * 100)
  };
}

function dedupeByUrl<T extends { url: string }>(jobs: T[]) {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    const key = job.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferCompany(title: string, rawUrl: string) {
  const atMatch = title.match(/\bat\s+([^|-]+)/i);
  if (atMatch?.[1]) return atMatch[1].trim();

  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (host.includes("greenhouse.io") || host.includes("lever.co")) return parts[0];
    return parts.length > 1 ? parts[parts.length - 2] : host;
  } catch {
    return "Unknown company";
  }
}

function cleanTitle(title: string, company: string) {
  return title
    .replace(new RegExp(`\\s+at\\s+${escapeRegExp(company)}.*$`, "i"), "")
    .replace(/\s+[|-]\s+.*$/, "")
    .trim() || title;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function presentJob<T extends { fitReasons: string | null }>(job: T) {
  return {
    ...job,
    fitReasons: fromJsonString<string[]>(job.fitReasons, [])
  };
}

export default router;
