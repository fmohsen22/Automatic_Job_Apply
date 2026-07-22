import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { audit } from "../services/audit.js";
import { presentApplicationRun, runApplyWorker } from "../services/applyWorker.js";
import { prepareDocumentsForJob, presentDocSet } from "../services/documentPreparation.js";
import { type AutonomyLevel, isGatedDomain } from "../services/domainPolicies.js";
import { checkJobLive, mapLimit } from "../services/jobFreshness.js";
import { companyFromHost, extractJobFromImage, extractTextFromFile, fetchJobPage } from "../services/jobImport.js";
import { rankJob } from "../services/jobRanking.js";
import { extractSearchIntent } from "../services/searchIntent.js";
import { readSettings } from "../services/settings.js";
import { searchTavily, type TavilyResult } from "../services/tavily.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

const JobSearchSchema = z.object({
  searchText: z.string().optional(),
  location: z.string().optional(),
  role: z.string().optional(),
  city: z.string().optional(),
  maxResults: z.number().int().min(1).max(2000).optional()
});

const PrepareSchema = z.object({
  instructions: z.string().optional(),
  template: z.string().optional()
});

const ApplySchema = z.object({
  autonomyLevel: z.enum(["L0", "L1", "L2"]).default("L1"),
  dryRun: z.boolean().optional().default(true)
});

router.get("/", asyncRoute(async (_req, res) => {
  // Hide postings already detected as expired/closed.
  const jobs = await prisma.job.findMany({
    where: { expired: false },
    orderBy: [{ fitScore: "desc" }, { updatedAt: "desc" }]
  });
  res.json(jobs.map(presentJob));
}));

const AddJobSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  file: z.object({
    name: z.string().min(1),
    type: z.string().optional().default(""),
    contentBase64: z.string().min(1)
  }).optional()
});

// Score a job against the user's latest (non-tailored) CV — shared by the
// add-job and refetch routes so both rank identically.
async function rankAgainstLatestCv(input: { title: string; company: string; description: string }) {
  const [settings, latestCv] = await Promise.all([
    readSettings(),
    prisma.cvVersion.findFirst({ where: { NOT: { source: { startsWith: "tailored:" } } }, orderBy: { createdAt: "desc" } })
  ]);
  const cv = latestCv ? fromJsonString(latestCv.json, {}) : {};
  let ranking = { score: 65, reasons: ["Added manually."] };
  try {
    ranking = await rankJob({
      cv,
      title: input.title,
      company: input.company,
      description: input.description,
      fallbackScore: 65,
      model: settings.searchModel || "google/gemini-2.5-flash-lite"
    });
  } catch {
    // keep the neutral fallback
  }
  return ranking;
}

// Add a job the user found themselves (by URL and/or pasted text), score the fit,
// and save it so they can prepare a tailored CV for it.
router.post("/", asyncRoute(async (req, res) => {
  const parsed = AddJobSchema.parse(req.body);
  const url = parsed.url?.trim() || "";
  let description = parsed.description?.trim() || "";
  let title = parsed.title?.trim() || "";
  let company = parsed.company?.trim() || "";
  let fetchedLocation = "";

  const settings = await readSettings();

  // If we have a URL but are missing details, fetch and extract them.
  if (/^https?:\/\//i.test(url) && (!description || !title)) {
    const fetched = await fetchJobPage(url);
    if (fetched) {
      title = title || fetched.title;
      company = company || fetched.company;
      description = description || fetched.description;
      fetchedLocation = fetched.location || "";
    }
  }

  // Read an uploaded file: a screenshot via a vision model, or a PDF/Word/text as text.
  if (parsed.file && (!description || !title)) {
    const file = parsed.file;
    const buffer = Buffer.from(file.contentBase64, "base64");
    const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name);
    if (isImage) {
      const fromImage = await extractJobFromImage(file.contentBase64, file.type || "image/png", settings.generalModel || "google/gemini-2.5-flash");
      if (fromImage) {
        title = title || fromImage.title;
        company = company || fromImage.company;
        description = description || fromImage.description;
      }
    } else {
      const text = await extractTextFromFile(buffer, file.name, file.type || "");
      if (text) description = description || text;
    }
  }

  if (url && !company) company = companyFromHost(url);
  if (!company) company = "Unknown company";
  if (!title) {
    const firstLine = description.split("\n").map((line) => line.trim()).find(Boolean) || "";
    title = firstLine.split(/\.\s/)[0].slice(0, 100) || "Saved job";
  }

  if (!description || description.length < 20) {
    throw new Error("Couldn't read that. Paste the job description, or upload a clearer PDF/Word/screenshot.");
  }

  const finalUrl = /^https?:\/\//i.test(url) ? url : `manual:${randomUUID()}`;
  const location = parsed.location?.trim() || fetchedLocation || "Not specified";

  const ranking = await rankAgainstLatestCv({ title, company, description });

  const saved = await prisma.job.upsert({
    where: { url: finalUrl },
    update: { source: "manual", company, title, location, descr: description, fitScore: ranking.score, fitReasons: toJsonString(ranking.reasons), expired: false, checkedAt: new Date() },
    create: { source: "manual", url: finalUrl, company, title, location, descr: description, fitScore: ranking.score, fitReasons: toJsonString(ranking.reasons), checkedAt: new Date() }
  });

  await audit("jobs.added.manual", `Added job: ${title} at ${company}`, {
    entity: "Job",
    entityId: saved.id,
    metadata: { url: finalUrl, fitScore: ranking.score }
  });
  res.status(201).json(presentJob(saved));
}));

// Re-check the freshness of saved jobs and hide the ones that are now expired.
router.post("/prune-expired", asyncRoute(async (_req, res) => {
  const jobs = await prisma.job.findMany({ where: { expired: false }, select: { id: true, url: true } });
  const results = await mapLimit(jobs, 10, (job) => checkJobLive(job.url));
  const expiredIds = jobs.filter((_, index) => !results[index].live).map((job) => job.id);
  const liveIds = jobs.filter((_, index) => results[index].live).map((job) => job.id);

  if (expiredIds.length) {
    await prisma.job.updateMany({ where: { id: { in: expiredIds } }, data: { expired: true, checkedAt: new Date() } });
  }
  if (liveIds.length) {
    await prisma.job.updateMany({ where: { id: { in: liveIds } }, data: { checkedAt: new Date() } });
  }

  await audit("jobs.pruned.expired", `Checked ${jobs.length} jobs, hid ${expiredIds.length} expired`, {
    entity: "Job",
    metadata: { checked: jobs.length, expired: expiredIds.length }
  });
  res.json({ checked: jobs.length, expired: expiredIds.length });
}));

router.get("/search-runs", asyncRoute(async (_req, res) => {
  const runs = await prisma.searchRun.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      results: {
        orderBy: { rank: "asc" },
        take: 3,
        include: { job: true }
      }
    },
    take: 50
  });

  res.json(runs.map((run) => ({
    ...run,
    queries: fromJsonString<string[]>(run.queries, []),
    topJobs: run.results.map((result) => presentJob(result.job))
  })));
}));

router.get("/search-runs/:id", asyncRoute(async (req, res) => {
  const run = await prisma.searchRun.findUnique({
    where: { id: req.params.id },
    include: {
      results: {
        orderBy: { rank: "asc" },
        include: { job: true }
      }
    }
  });

  if (!run) {
    res.status(404).json({ error: "Search run not found" });
    return;
  }

  res.json({
    ...run,
    queries: fromJsonString<string[]>(run.queries, []),
    jobs: run.results.map((result) => presentJob(result.job))
  });
}));

router.post("/search", asyncRoute(async (req, res) => {
  const parsed = JobSearchSchema.parse(req.body);
  const searchText = (parsed.searchText || [parsed.role, parsed.city].filter(Boolean).join(" ")).trim();
  if (searchText.length < 5) {
    throw new Error("Describe what kind of jobs you want in at least a few words.");
  }
  const location = (parsed.location || parsed.city || "").trim();
  const targetResults = parsed.maxResults ?? Number(process.env.SEARCH_TARGET_RESULTS || 500);
  const safeTargetResults = Math.min(Math.max(targetResults, 1), 2000);
  const [settings, latestCv] = await Promise.all([
    readSettings(),
    prisma.cvVersion.findFirst({
      where: { NOT: { source: { startsWith: "tailored:" } } },
      orderBy: { createdAt: "desc" }
    })
  ]);
  const searchRun = await prisma.searchRun.create({
    data: {
      role: searchText,
      city: location || "Any",
      maxResults: safeTargetResults,
      status: "RUNNING"
    }
  });

  const profile = await prisma.jobProfile.create({
    data: {
      city: location || "Any",
      roles: searchText,
      filters: toJsonString({ targetResults: safeTargetResults })
    }
  });

  await audit("jobs.search.started", `Searching jobs for: ${searchText}`, {
    entity: "JobProfile",
    entityId: profile.id,
    metadata: { source: "tavily", location, targetResults: safeTargetResults, searchRunId: searchRun.id }
  });

  try {
    // Understand the free-text request first: pull out the roles, location and
    // skills to actually search for (instead of feeding the whole paragraph in).
    const intent = await extractSearchIntent(searchText, location, settings.searchModel || "google/gemini-2.5-flash-lite");
    const effectiveLocation = location || intent.location;

    const tavily = await searchTavily({ roles: intent.roles, location: effectiveLocation, keywords: intent.keywords, targetResults: safeTargetResults });
    await prisma.searchRun.update({
      where: { id: searchRun.id },
      data: { queries: toJsonString(tavily.queries) }
    });

    // Process the best slice (Tavily already returns by relevance). Checking
    // freshness + ranking is bounded so a search finishes in under a minute.
    const processLimit = Math.min(safeTargetResults, 60);
    const normalized = dedupeByUrl(tavily.results.map((result) => normalizeJob(result, effectiveLocation || inferLocation(searchText)))).slice(0, processLimit);
    const cv = latestCv ? fromJsonString(latestCv.json, {}) : {};

    // Drop postings that are already expired/closed before we rank or save them.
    const freshness = await mapLimit(normalized, 12, (job) => checkJobLive(job.url, 6000));
    const liveJobs = normalized.filter((_, index) => freshness[index].live);
    const expiredFiltered = normalized.length - liveJobs.length;

    // Rank jobs concurrently so the search finishes quickly.
    const ranked = await mapLimit(liveJobs, 8, async (job) => {
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
          fitReasons: toJsonString(ranking.reasons),
          expired: false,
          checkedAt: new Date()
        },
        create: {
          source: job.source,
          url: job.url,
          company: job.company,
          title: job.title,
          location: job.location,
          descr: job.descr,
          fitScore: ranking.score,
          fitReasons: toJsonString(ranking.reasons),
          checkedAt: new Date()
        }
      });
      return presentJob(saved);
    });

    ranked.sort((a, b) => b.fitScore - a.fitScore);
    await prisma.$transaction(
      ranked.map((job, index) =>
        prisma.searchRunJob.upsert({
          where: { searchRunId_jobId: { searchRunId: searchRun.id, jobId: job.id } },
          update: { rank: index + 1 },
          create: { searchRunId: searchRun.id, jobId: job.id, rank: index + 1 }
        })
      )
    );
    await prisma.searchRun.update({
      where: { id: searchRun.id },
      data: { resultCount: ranked.length, status: "COMPLETED" }
    });

    await audit("jobs.search.completed", `Found ${ranked.length} jobs for: ${searchText}`, {
      entity: "SearchRun",
      entityId: searchRun.id,
      metadata: {
        tavilyResults: tavily.results.length,
        savedJobs: ranked.length,
        expiredFiltered,
        interpretedRoles: intent.roles,
        interpretedLocation: effectiveLocation,
        rankingProvider: "openrouter",
        rankingModel: settings.searchModel || "google/gemini-2.5-flash-lite",
        queries: tavily.queries,
        partialErrors: tavily.errors
      }
    });

    res.json({ jobs: ranked, profileId: profile.id, searchRunId: searchRun.id, expiredFiltered, interpreted: { roles: intent.roles, location: effectiveLocation } });
  } catch (error) {
    await prisma.searchRun.update({
      where: { id: searchRun.id },
      data: { status: "FAILED" }
    });
    throw error;
  }
}));

// Re-fetch a job's posting from its URL (e.g. after an import grabbed nav junk),
// replace the stored details, and re-rank it against the user's CV.
router.post("/:id/refetch", asyncRoute(async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!/^https?:\/\//i.test(job.url)) {
    res.status(400).json({ error: "This job has no fetchable URL (it was added manually). Edit it or add it again with a link." });
    return;
  }

  const fetched = await fetchJobPage(job.url);
  if (!fetched) {
    res.status(400).json({ error: "Couldn't re-fetch the job page. The posting may be gone or the site blocked the request." });
    return;
  }

  const title = fetched.title || job.title;
  const company = fetched.company || job.company;
  const location = fetched.location || job.location;
  const description = fetched.description;
  const ranking = await rankAgainstLatestCv({ title, company, description });

  const saved = await prisma.job.update({
    where: { id: job.id },
    data: {
      title,
      company,
      location,
      descr: description,
      fitScore: ranking.score,
      fitReasons: toJsonString(ranking.reasons),
      expired: false,
      checkedAt: new Date()
    }
  });

  await audit("jobs.refetched", `Re-fetched job: ${title} at ${company}`, {
    entity: "Job",
    entityId: saved.id,
    metadata: { url: job.url, fitScore: ranking.score }
  });
  res.json(presentJob(saved));
}));

router.post("/:id/prepare", asyncRoute(async (req, res) => {
  const parsed = PrepareSchema.parse(req.body);
  const docSet = await prepareDocumentsForJob(req.params.id, parsed.instructions, parsed.template);
  res.status(201).json(docSet);
}));

router.post("/:id/apply", asyncRoute(async (req, res) => {
  const parsed = ApplySchema.parse(req.body);
  const run = await runApplyWorker(req.params.id, {
    autonomyLevel: parsed.autonomyLevel as AutonomyLevel,
    dryRun: parsed.dryRun
  });
  res.status(201).json(run);
}));

router.get("/:id/runs", asyncRoute(async (req, res) => {
  const runs = await prisma.applicationRun.findMany({
    where: { jobId: req.params.id },
    orderBy: { createdAt: "desc" }
  });
  res.json(runs.map(presentApplicationRun));
}));

router.get("/:id", asyncRoute(async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      docSets: {
        orderBy: { createdAt: "desc" },
        include: { cvVersion: true }
      },
      runs: {
        orderBy: { createdAt: "desc" }
      }
    }
  });

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({
    ...presentJob(job),
    docSets: job.docSets.map((docSet) => ({
      ...presentDocSet(docSet),
      checklist: fromJsonString(docSet.checklist, []),
      cvVersion: presentCvVersion(docSet.cvVersion)
    })),
    runs: job.runs.map(presentApplicationRun)
  });
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

function inferLocation(searchText: string) {
  const remote = searchText.match(/\bremote\b/i);
  if (remote) return "Remote";

  const inMatch = searchText.match(/\b(?:in|near|around|based in)\s+([A-Za-z][A-Za-z\s,-]{1,60})/i);
  if (inMatch?.[1]) {
    return inMatch[1].replace(/[.?!].*$/, "").trim();
  }

  return "Not specified";
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

function presentJob<T extends { fitReasons: string | null; url: string }>(job: T) {
  return {
    ...job,
    fitReasons: fromJsonString<string[]>(job.fitReasons, []),
    gated: isGatedDomain(job.url)
  };
}

function presentCvVersion<T extends { json: string }>(version: T) {
  return {
    ...version,
    json: fromJsonString(version.json, {})
  };
}

export default router;
