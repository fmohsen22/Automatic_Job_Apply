import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Router, type Response } from "express";
import { prisma } from "../db.js";
import { isInsideStorage } from "../services/fileStore.js";
import { asyncRoute } from "../utils/asyncRoute.js";

const router = Router();

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  html: "text/html"
} as const;

async function sendCv(res: Response, docSetId: string, kind: "docx" | "pdf" | "html") {
  const docSet = await prisma.docSet.findUnique({
    where: { id: docSetId },
    include: { job: true }
  });

  if (!docSet) {
    res.status(404).json({ error: "Document set not found." });
    return;
  }

  const filePath = kind === "pdf" ? docSet.cvPdfPath : kind === "html" ? docSet.cvHtmlPath : docSet.cvDocxPath;
  if (!filePath || !isInsideStorage(filePath)) {
    res.status(404).json({ error: `No ${kind.toUpperCase()} is available for this document set yet.` });
    return;
  }

  try {
    await stat(filePath);
  } catch {
    res.status(404).json({ error: "The generated file is no longer on disk. Prepare materials again." });
    return;
  }

  const base = safeName(`${docSet.job?.company ?? "company"}_${docSet.job?.title ?? "cv"}_CV`);
  res.setHeader("Content-Type", MIME[kind]);
  res.setHeader("Content-Disposition", `attachment; filename="${base}.${kind}"`);
  createReadStream(filePath).pipe(res);
}

router.get("/:id/cv.docx", asyncRoute((req, res) => sendCv(res, req.params.id, "docx")));
router.get("/:id/cv.pdf", asyncRoute((req, res) => sendCv(res, req.params.id, "pdf")));
router.get("/:id/cv.html", asyncRoute((req, res) => sendCv(res, req.params.id, "html")));

export default router;

function safeName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "tailored_cv";
}
