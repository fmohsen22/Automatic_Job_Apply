import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { audit } from "../services/audit.js";
import { hashContent, parseCvFile, selectBestCvFile } from "../services/cvImport.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

const CvImportSchema = z.object({
  cvKey: z.string().min(1).optional(),
  label: z.string().min(1),
  source: z.string().optional(),
  content: z.union([z.string(), z.record(z.unknown())])
});

function normalizeCv(content: string | Record<string, unknown>) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {
      rawText: content,
      basics: {},
      experience: [],
      education: [],
      skills: []
    };
  }
}

function serializeCv(content: string | Record<string, unknown>) {
  return toJsonString(normalizeCv(content));
}

function hashCv(content: Record<string, unknown>) {
  return hashContent(content);
}

function presentVersion<T extends { json: string }>(version: T) {
  return {
    ...version,
    json: fromJsonString(version.json, {}),
    structuredJson: fromJsonString(version.json, {})
  };
}

router.get("/", asyncRoute(async (_req, res) => {
  const versions = await prisma.cvVersion.findMany({ orderBy: { createdAt: "desc" } });
  res.json(versions.map(presentVersion));
}));

router.get("/latest", asyncRoute(async (_req, res) => {
  const latest = await prisma.cvVersion.findFirst({ orderBy: { createdAt: "desc" } });
  res.json(latest ? presentVersion(latest) : null);
}));

router.get("/:cvKey/versions", asyncRoute(async (req, res) => {
  const versions = await prisma.cvVersion.findMany({
    where: { cvKey: req.params.cvKey },
    orderBy: { version: "desc" }
  });
  res.json(versions.map(presentVersion));
}));

async function importCv(req: Request, res: Response) {
  const parsed = CvImportSchema.parse(req.body);
  const cvKey = parsed.cvKey || parsed.label;
  const normalized = normalizeCv(parsed.content);
  const latest = await prisma.cvVersion.findFirst({
    where: { cvKey },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  const version = await prisma.cvVersion.create({
    data: {
      cvKey,
      version: (latest?.version || 0) + 1,
      label: parsed.label,
      source: parsed.source || "paste",
      json: toJsonString(normalized),
      contentHash: hashCv(normalized)
    }
  });
  await audit("cv.imported", `CV version imported: ${version.label}`, {
    entity: "CvVersion",
    entityId: version.id,
    metadata: {
      cvKey,
      version: version.version,
      source: version.source,
      contentHash: version.contentHash
    }
  });
  res.status(201).json(presentVersion(version));
}

router.post("/", asyncRoute(importCv));
router.post("/import", asyncRoute(importCv));
router.post("/import-files", asyncRoute(async (req, res) => {
  const parsed = z.object({
    cvKey: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    files: z.array(z.object({
      name: z.string().min(1),
      type: z.string().optional().default(""),
      contentBase64: z.string().min(1)
    })).min(1)
  }).parse(req.body);

  const selected = selectBestCvFile(parsed.files);
  if (!selected) {
    throw new Error("No CV files found in the folder.");
  }

  const content = await parseCvFile(selected);
  const normalized = typeof content === "string" ? normalizeCv(content) : content;
  const label = parsed.label || selected.name.replace(/\.[^.]+$/, "");
  const cvKey = parsed.cvKey || label;
  const latest = await prisma.cvVersion.findFirst({
    where: { cvKey },
    orderBy: { version: "desc" },
    select: { version: true }
  });

  const version = await prisma.cvVersion.create({
    data: {
      cvKey,
      version: (latest?.version || 0) + 1,
      label,
      source: `folder:${selected.name}`,
      json: toJsonString(normalized),
      contentHash: hashCv(normalized as Record<string, unknown>)
    }
  });
  await audit("cv.imported", `CV folder imported: ${version.label}`, {
    entity: "CvVersion",
    entityId: version.id,
    metadata: {
      cvKey,
      version: version.version,
      source: version.source,
      fileName: selected.name,
      contentHash: version.contentHash
    }
  });
  res.status(201).json(presentVersion(version));
}));

router.put("/:id", asyncRoute(async (req, res) => {
  const parsed = CvImportSchema.partial({ label: true }).parse(req.body);
  const normalized = parsed.content === undefined ? undefined : normalizeCv(parsed.content);
  const updated = await prisma.cvVersion.update({
    where: { id: req.params.id },
    data: {
      label: parsed.label,
      source: parsed.source,
      json: normalized === undefined ? undefined : toJsonString(normalized),
      contentHash: normalized === undefined ? undefined : hashCv(normalized)
    }
  });
  await audit("cv.updated", `CV version updated: ${updated.label}`, {
    entity: "CvVersion",
    entityId: updated.id
  });
  res.json(presentVersion(updated));
}));

export default router;
