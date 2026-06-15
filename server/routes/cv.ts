import path from "node:path";
import { createReadStream } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { audit } from "../services/audit.js";
import { hashContent, parseCvFile } from "../services/cvImport.js";
import { cvAssetDir, writeStoredFile } from "../services/fileStore.js";
import { getPhotoPath, savePhoto } from "../services/photo.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

// Which original uploads we keep on disk so they can be re-rendered later.
// Only .docx can be tailored with exact formatting; we keep .pdf too as the source of record.
function assetTypeFor(file: { name: string; type?: string }): "docx" | "pdf" | null {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx") || /wordprocessingml/.test(file.type ?? "")) return "docx";
  if (lower.endsWith(".pdf") || /pdf/.test(file.type ?? "")) return "pdf";
  return null;
}

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
  // Only user-imported CVs/materials — not per-job tailored outputs, which would
  // clutter the list and could be wrongly picked as a template.
  const versions = await prisma.cvVersion.findMany({
    where: { NOT: { source: { startsWith: "tailored:" } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(versions.map(presentVersion));
}));

router.get("/latest", asyncRoute(async (_req, res) => {
  const latest = await prisma.cvVersion.findFirst({ orderBy: { createdAt: "desc" } });
  res.json(latest ? presentVersion(latest) : null);
}));

router.post("/photo", asyncRoute(async (req, res) => {
  const parsed = z.object({
    contentBase64: z.string().min(1),
    name: z.string().optional(),
    type: z.string().optional()
  }).parse(req.body);
  const ext = (parsed.name?.split(".").pop() || (parsed.type?.includes("png") ? "png" : "jpg")).toLowerCase();
  await savePhoto(Buffer.from(parsed.contentBase64, "base64"), ext);
  await audit("cv.photo.saved", "Profile photo uploaded", { entity: "Photo" });
  res.status(201).json({ ok: true, hasPhoto: true });
}));

router.get("/photo", asyncRoute(async (_req, res) => {
  const photoPath = await getPhotoPath();
  if (!photoPath) {
    res.status(404).json({ error: "No photo uploaded." });
    return;
  }
  const ext = path.extname(photoPath).toLowerCase();
  res.setHeader("Content-Type", ext === ".png" ? "image/png" : "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(photoPath).pipe(res);
}));

router.get("/template", asyncRoute(async (_req, res) => {
  const setting = await prisma.appSetting.findUnique({ where: { key: "templateCvVersionId" } });
  const selected = setting
    ? await prisma.cvVersion.findUnique({ where: { id: setting.value } })
    : null;
  const fallback = selected ?? await prisma.cvVersion.findFirst({
    where: { NOT: { source: { startsWith: "tailored:" } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(fallback ? presentVersion(fallback) : null);
}));

router.put("/:id/evidence", asyncRoute(async (req, res) => {
  const parsed = z.object({ include: z.boolean() }).parse(req.body);
  const updated = await prisma.cvVersion.update({
    where: { id: req.params.id },
    data: { includeEvidence: parsed.include }
  });
  await audit("cv.evidence.toggled", `${updated.label} ${parsed.include ? "included as" : "excluded from"} evidence`, {
    entity: "CvVersion",
    entityId: updated.id
  });
  res.json(presentVersion(updated));
}));

router.put("/template", asyncRoute(async (req, res) => {
  const parsed = z.object({
    cvVersionId: z.string().min(1)
  }).parse(req.body);
  const version = await prisma.cvVersion.findUnique({ where: { id: parsed.cvVersionId } });
  if (!version) {
    throw new Error("CV version not found.");
  }

  await prisma.appSetting.upsert({
    where: { key: "templateCvVersionId" },
    update: { value: version.id },
    create: { key: "templateCvVersionId", value: version.id }
  });

  await audit("cv.template.selected", `Template CV selected: ${version.label}`, {
    entity: "CvVersion",
    entityId: version.id
  });

  res.json(presentVersion(version));
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

  const versions = [];
  for (const file of parsed.files.filter(isSupportedCvFile)) {
    const content = await parseCvFile(file);
    const normalized = typeof content === "string" ? normalizeCv(content) : content;
    const label = parsed.files.length === 1 && parsed.label ? parsed.label : file.name.replace(/\.[^.]+$/, "");
    const cvKey = parsed.cvKey || label;
    const latest = await prisma.cvVersion.findFirst({
      where: { cvKey },
      orderBy: { version: "desc" },
      select: { version: true }
    });

    let version = await prisma.cvVersion.create({
      data: {
        cvKey,
        version: (latest?.version || 0) + 1,
        label,
        source: `folder:${file.name}`,
        json: toJsonString(normalized),
        contentHash: hashCv(normalized as Record<string, unknown>)
      }
    });

    // Keep the original bytes so we can re-render the exact layout later.
    const assetType = assetTypeFor(file);
    if (assetType) {
      const assetPath = path.join(cvAssetDir(), `${version.id}.${assetType}`);
      await writeStoredFile(assetPath, Buffer.from(file.contentBase64, "base64"));
      version = await prisma.cvVersion.update({
        where: { id: version.id },
        data: { assetPath, assetType }
      });
    }

    versions.push(version);
  }

  if (!versions.length) {
    throw new Error("No supported CV files found. Use PDF, DOCX, JSON, TXT, or MD files.");
  }

  await audit("cv.imported", `Imported ${versions.length} CV files`, {
    entity: "CvVersion",
    metadata: {
      count: versions.length,
      fileNames: versions.map((version) => version.source)
    }
  });

  res.status(201).json(versions.map(presentVersion));
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

function isSupportedCvFile(file: { name: string; type?: string }) {
  const lower = file.name.toLowerCase();
  return [".pdf", ".docx", ".json", ".txt", ".md"].some((extension) => lower.endsWith(extension)) ||
    /pdf|json|text|wordprocessingml/.test(file.type ?? "");
}
