import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { audit } from "./audit.js";
import { hashContent } from "./cvImport.js";
import { isStructuredCv, type StructuredCv } from "./cvStructure.js";
import { applyDocxReplacements, extractDocxSegments, swapDocxImages } from "./docxTailor.js";
import { convertDocxToPdf } from "./documentRender.js";
import { docSetDir, writeStoredFile } from "./fileStore.js";
import { renderHtmlToPdf } from "./htmlRender.js";
import { runLlm } from "./llm.js";
import { makeSquareJpeg } from "./photo.js";
import { readSettings } from "./settings.js";
import { docxTemplatePath, getTemplate } from "./templates.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { extractLooseJson } from "../utils/llmJson.js";

const CV_MARKER = "<<<TAILORED_CV>>>";
const COVER_MARKER = "<<<COVER_LETTER>>>";
const CHECKLIST_MARKER = "<<<CHECKLIST_JSON>>>";
const SEGMENTS_MARKER = "<<<CV_SEGMENTS>>>";
const CV_JSON_MARKER = "<<<CV_JSON>>>";

type ChecklistItem = {
  requirement: string;
  status: "met" | "missing" | "address";
  evidence?: string;
  plan?: string;
};

type PreparationResponse = {
  tailoredCv?: unknown;
  coverLetter?: string;
  checklist?: ChecklistItem[];
};

type SupportingMaterial = {
  label: string;
  source?: string | null;
  content: unknown;
};

type JobContext = {
  title: string;
  company: string;
  location?: string | null;
  description: string;
  url: string;
};

export async function prepareDocumentsForJob(jobId: string, instructions?: string, templateId?: string) {
  const [job, templateCv, supportingMaterials, settings] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    readTemplateCv(),
    readSupportingMaterials(),
    readSettings()
  ]);

  if (!job) {
    throw new Error("Job not found.");
  }

  if (!templateCv) {
    throw new Error("Import CVs and select one template CV before preparing documents.");
  }

  const baseCv = fromJsonString<Record<string, unknown>>(templateCv.json, {});
  const model = settings.tailorModel || "anthropic/claude-sonnet-4.5";
  const supporting: SupportingMaterial[] = supportingMaterials
    .filter((material) => material.id !== templateCv.id)
    .slice(0, 12)
    .map((material) => ({
      label: material.label,
      source: material.source,
      content: fromJsonString(material.json, {})
    }));
  const jobContext: JobContext = {
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.descr,
    url: job.url
  };

  // Output modes:
  //  - HTML gallery template  -> render structured content to HTML -> PDF
  //  - DOCX gallery template  -> pour content into a designed .docx + photo -> Word/PDF
  //  - "word"                 -> rewrite the candidate's own uploaded .docx in place
  //  - "text"                 -> plain-text fallback
  const canUseDocx = templateCv.assetType === "docx"
    && Boolean(templateCv.assetPath)
    && existsSync(templateCv.assetPath as string);
  const gallery = templateId ? getTemplate(templateId) : undefined;

  let tailoredCvJson: Record<string, unknown>;
  let coverLetter: string;
  let checklist: ChecklistItem[];
  let tailoredDocx: Buffer | null = null;
  let templateHtml: string | null = null;
  let formatMode: string;
  const usedTemplateId = gallery?.id ?? null;

  if (gallery?.kind === "html") {
    const result = await generateTemplateCv({ model, baseCv, supportingMaterials: supporting, job: jobContext, instructions });
    templateHtml = gallery.render(result.cv);
    tailoredCvJson = { ...(result.cv as unknown as Record<string, unknown>), rawText: flattenStructuredCv(result.cv) };
    coverLetter = result.coverLetter;
    checklist = result.checklist;
    formatMode = "template";
  } else if (gallery?.kind === "docx") {
    const fill = await fillTemplateDocx({
      model,
      templateDocx: await readFile(docxTemplatePath(gallery.file)),
      baseCv,
      supportingMaterials: supporting,
      job: jobContext,
      instructions
    });
    let buffer = fill.docxBuffer;
    if (gallery.photo) {
      const image = await makeSquareJpeg(gallery.photo.size);
      if (image) buffer = swapDocxImages(buffer, gallery.photo.parts, image);
    }
    tailoredDocx = buffer;
    tailoredCvJson = { ...baseCv, rawText: fill.cvText };
    coverLetter = fill.coverLetter;
    checklist = fill.checklist;
    formatMode = "template";
  } else if (canUseDocx && (templateId === "word" || !templateId)) {
    const docx = await generateTailoredDocx({
      model,
      originalDocx: await readFile(templateCv.assetPath as string),
      supportingMaterials: supporting,
      job: jobContext,
      instructions
    });
    tailoredDocx = docx.docxBuffer;
    tailoredCvJson = { ...baseCv, rawText: docx.cvText };
    coverLetter = docx.coverLetter;
    checklist = docx.checklist;
    formatMode = "docx";
  } else {
    const generated = await generateDocuments({ model, baseCv, supportingMaterials: supporting, job: jobContext, instructions });
    tailoredCvJson = (generated.tailoredCv as Record<string, unknown>) ?? baseCv;
    coverLetter = generated.coverLetter || "";
    checklist = Array.isArray(generated.checklist) ? generated.checklist : [];
    formatMode = "text";
  }

  const nextVersion = await nextCvVersion(`job:${job.id}`);
  const cvVersion = await prisma.cvVersion.create({
    data: {
      cvKey: `job:${job.id}`,
      version: nextVersion,
      label: `${job.company} - ${job.title}`,
      source: `tailored:${job.id}:template:${templateCv.id}`,
      json: toJsonString(tailoredCvJson),
      contentHash: hashContent(tailoredCvJson)
    }
  });

  let docSet = await prisma.docSet.create({
    data: {
      jobId: job.id,
      cvVersionId: cvVersion.id,
      coverLetter,
      checklist: toJsonString(checklist),
      formatMode,
      templateId: usedTemplateId,
      status: "DRAFT"
    },
    include: {
      cvVersion: true,
      job: true
    }
  });

  // Persist the generated files, then render a matching PDF.
  let pdfRendered = false;
  const dir = docSetDir(docSet.id);
  if (tailoredDocx) {
    const cvDocxPath = path.join(dir, "cv.docx");
    await writeStoredFile(cvDocxPath, tailoredDocx);
    const cvPdfPath = await convertDocxToPdf(cvDocxPath, dir);
    pdfRendered = Boolean(cvPdfPath);
    docSet = await prisma.docSet.update({
      where: { id: docSet.id },
      data: { cvDocxPath, cvPdfPath },
      include: { cvVersion: true, job: true }
    });
  } else if (templateHtml) {
    const cvHtmlPath = path.join(dir, "cv.html");
    await writeStoredFile(cvHtmlPath, Buffer.from(templateHtml, "utf8"));
    const cvPdfPath = await renderHtmlToPdf(templateHtml, path.join(dir, "cv.pdf"));
    pdfRendered = Boolean(cvPdfPath);
    docSet = await prisma.docSet.update({
      where: { id: docSet.id },
      data: { cvHtmlPath, cvPdfPath },
      include: { cvVersion: true, job: true }
    });
  }

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "PREPARED" }
  });

  await audit("documents.prepared", `Prepared CV and cover letter for ${job.title} at ${job.company}`, {
    entity: "DocSet",
    entityId: docSet.id,
    metadata: {
      jobId: job.id,
      cvVersionId: cvVersion.id,
      model,
      formatMode: docSet.formatMode,
      pdfRendered,
      templateCvVersionId: templateCv.id,
      supportingMaterialCount: supportingMaterials.length,
      checklistItems: checklist.length
    }
  });

  return {
    ...presentDocSet(docSet),
    checklist,
    cvVersion: {
      ...cvVersion,
      json: tailoredCvJson
    }
  };
}

// Shared shape so the prepare response and the job-detail route agree on what
// the UI gets (downloadable flags instead of raw server paths).
export function presentDocSet<T extends {
  cvDocxPath?: string | null;
  cvPdfPath?: string | null;
  cvHtmlPath?: string | null;
  formatMode?: string;
}>(docSet: T) {
  const { cvDocxPath, cvPdfPath, cvHtmlPath, ...rest } = docSet;
  return {
    ...rest,
    cvDocxAvailable: Boolean(cvDocxPath),
    cvPdfAvailable: Boolean(cvPdfPath),
    cvHtmlAvailable: Boolean(cvHtmlPath)
  };
}

// Exact-format path: rewrite the paragraphs of the original .docx and keep all
// styling. The model only returns new wording per paragraph number, so there is
// no large JSON-embedded blob to mis-escape.
async function generateTailoredDocx(input: {
  model: string;
  originalDocx: Buffer;
  supportingMaterials: SupportingMaterial[];
  job: JobContext;
  instructions?: string;
}): Promise<{ docxBuffer: Buffer; cvText: string; coverLetter: string; checklist: ChecklistItem[] }> {
  const segments = extractDocxSegments(input.originalDocx);
  const candidates = segments.filter((segment) => segment.text.trim().length > 0);
  if (!candidates.length) {
    throw new Error("The selected Word CV has no readable paragraphs to tailor. Re-import the .docx file.");
  }

  const numberedSegments = candidates.map((segment) => `@@${segment.index}@@ ${segment.text}`).join("\n");
  const userPayload = [
    `JOB TITLE: ${input.job.title}`,
    `COMPANY: ${input.job.company}`,
    `LOCATION: ${input.job.location ?? "Not specified"}`,
    "",
    "JOB DESCRIPTION:",
    input.job.description,
    "",
    "SUPPORTING MATERIALS (facts about the candidate, use as evidence only):",
    JSON.stringify(input.supportingMaterials),
    "",
    `USER INSTRUCTIONS: ${input.instructions || "(none)"}`,
    "",
    "CV SEGMENTS (rewrite the wording of the ones that should better match the job; keep the same numbers):",
    numberedSegments
  ].join("\n");

  const response = await runLlmGuarded({
    model: input.model,
    responseFormat: "text",
    maxTokens: 8000,
    messages: [
      {
        role: "system",
        content:
          "You tailor a candidate's existing CV to one job WITHOUT changing its layout.\n\n" +
          "FAITHFULNESS (most important): Keep the candidate's real professional identity, headline, and career exactly as written. Do NOT rebrand them into a different profession or invent a new role title to match the job (for example, never relabel a petroleum / AI-automation engineer as a 'UI/UX Engineer'). Never invent or imply employers, job titles, degrees, dates, certificates, tools, skills, or experience the candidate does not already have in the materials. Prefer MINIMAL edits: only change wording where it genuinely surfaces existing, relevant strengths for this job. When in doubt, leave the segment unchanged.\n\n" +
          "The CV is given as numbered text segments (one per paragraph). Rewrite ONLY the wording of segments that should better match the job. Keep each rewritten segment roughly the same length and on a SINGLE line. Do not change the person's name, contact details, dates, or company names. If a segment should stay as-is, leave it out of your output.\n\n" +
          "Respond with EXACTLY these three sections, each starting with its marker on its own line, and nothing else:\n\n" +
          `${SEGMENTS_MARKER}\n` +
          "One line per changed segment, in the form: @@<number>@@ <rewritten text>  (use the numbers shown in the input; output only changed segments).\n\n" +
          `${COVER_MARKER}\n` +
          "A concise, specific cover letter for this job, as plain text. Only reference real experience from the materials; do not fabricate roles, projects, or skills.\n\n" +
          `${CHECKLIST_MARKER}\n` +
          'A valid JSON array. Each element is an object with keys: "requirement" (string), "status" (one of "met", "missing", "address"), "evidence" (string), "plan" (string).'
      },
      { role: "user", content: userPayload }
    ]
  });

  const parsed = parseDocxResponse(response, segments);
  const replacements = parsed.replacements;
  const docxBuffer = replacements.size
    ? applyDocxReplacements(input.originalDocx, replacements)
    : input.originalDocx;

  const cvText = segments
    .map((segment) => replacements.get(segment.index) ?? segment.text)
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return {
    docxBuffer,
    cvText,
    coverLetter: parsed.coverLetter,
    checklist: parsed.checklist
  };
}

const TEMPLATE_FILL_SYSTEM_PROMPT =
  "You fill a CV template with a candidate's real content, tailored to one job.\n\n" +
  "You are given the template as numbered SLOTS, each currently holding SAMPLE text (a fake person's details). For EACH slot, infer its purpose from the sample (name, job title, contact line, section heading, summary, a job entry, a bullet, a skill, education, etc.) and replace it with the CANDIDATE'S real, job-tailored content that fits that slot. Replace ALL sample names, contacts, companies and details with the candidate's real ones. Keep pure section HEADINGS (like 'Experience', 'Education', 'Skills') unchanged. Keep each slot's length similar to its sample so the layout still fits.\n\n" +
  "FAITHFULNESS: Use only facts from the candidate's real CV and materials. Never invent employers, job titles, degrees, dates, certificates, tools, or skills. If the template has more slots than the candidate has real content, reuse or condense the candidate's real content sensibly — never fabricate. If a slot has no matching real content, use the closest real content or leave it unchanged.\n\n" +
  "Respond with EXACTLY these three sections, each starting with its marker on its own line:\n\n" +
  SEGMENTS_MARKER + "\n" +
  "One line per slot you fill, in the form: @@<number>@@ <new text>  (use the numbers shown; output a line for every slot that should change).\n\n" +
  COVER_MARKER + "\n" +
  "A concise, specific cover letter as plain text, using real experience only.\n\n" +
  CHECKLIST_MARKER + "\n" +
  'A valid JSON array; each item is {"requirement": string, "status": "met"|"missing"|"address", "evidence": string, "plan": string}.';

// Pour the candidate's tailored content into a designed .docx template (whose
// slots currently hold sample text), keeping the template's exact layout.
async function fillTemplateDocx(input: {
  model: string;
  templateDocx: Buffer;
  baseCv: unknown;
  supportingMaterials: SupportingMaterial[];
  job: JobContext;
  instructions?: string;
}): Promise<{ docxBuffer: Buffer; cvText: string; coverLetter: string; checklist: ChecklistItem[] }> {
  const segments = extractDocxSegments(input.templateDocx);
  const candidates = segments.filter((segment) => segment.text.trim().length > 0);
  if (!candidates.length) {
    throw new Error("This template has no editable text to fill. Pick another template.");
  }

  const numbered = candidates.map((segment) => `@@${segment.index}@@ ${segment.text}`).join("\n");
  const baseText = typeof (input.baseCv as { rawText?: unknown })?.rawText === "string"
    ? (input.baseCv as { rawText: string }).rawText
    : JSON.stringify(input.baseCv);

  const userPayload = [
    `JOB TITLE: ${input.job.title}`,
    `COMPANY: ${input.job.company}`,
    `LOCATION: ${input.job.location ?? "Not specified"}`,
    "",
    "JOB DESCRIPTION:",
    input.job.description,
    "",
    "CANDIDATE'S REAL CV (the only source of facts):",
    baseText,
    "",
    "SUPPORTING MATERIALS:",
    JSON.stringify(input.supportingMaterials),
    "",
    `USER INSTRUCTIONS: ${input.instructions || "(none)"}`,
    "",
    "CV TEMPLATE SLOTS (each holds SAMPLE text — replace with the candidate's real, tailored content that fits the slot):",
    numbered
  ].join("\n");

  const response = await runLlmGuarded({
    model: input.model,
    responseFormat: "text",
    maxTokens: 8000,
    messages: [
      { role: "system", content: TEMPLATE_FILL_SYSTEM_PROMPT },
      { role: "user", content: userPayload }
    ]
  });

  const parsed = parseDocxResponse(response, segments);
  const replacements = parsed.replacements;
  const docxBuffer = replacements.size
    ? applyDocxReplacements(input.templateDocx, replacements)
    : input.templateDocx;
  const cvText = segments
    .map((segment) => replacements.get(segment.index) ?? segment.text)
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return { docxBuffer, cvText, coverLetter: parsed.coverLetter, checklist: parsed.checklist };
}

function parseDocxResponse(response: string, segments: Array<{ index: number; text: string }>) {
  const text = response?.trim() ?? "";
  const segIdx = text.indexOf(SEGMENTS_MARKER);
  const coverIdx = text.indexOf(COVER_MARKER);
  const checklistIdx = text.indexOf(CHECKLIST_MARKER);

  const segBlock = segIdx >= 0
    ? text.slice(segIdx + SEGMENTS_MARKER.length, firstAfter(segIdx, [coverIdx, checklistIdx], text.length))
    : "";
  const coverLetter = coverIdx >= 0
    ? text.slice(coverIdx + COVER_MARKER.length, firstAfter(coverIdx, [checklistIdx], text.length)).trim()
    : "";
  const checklistRaw = checklistIdx >= 0 ? text.slice(checklistIdx + CHECKLIST_MARKER.length) : "";

  const validIndexes = new Set(segments.map((segment) => segment.index));
  const replacements = new Map<number, string>();
  let lastIndex: number | null = null;
  for (const rawLine of segBlock.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const match = line.match(/^\s*@@(\d+)@@\s?(.*)$/);
    if (match) {
      const index = Number(match[1]);
      if (validIndexes.has(index)) {
        replacements.set(index, match[2].trim());
        lastIndex = index;
      } else {
        lastIndex = null;
      }
    } else if (lastIndex !== null && line.trim()) {
      // A rewritten segment that wrapped onto the next line.
      replacements.set(lastIndex, `${replacements.get(lastIndex) ?? ""} ${line.trim()}`.trim());
    }
  }
  // Drop no-op or emptied replacements so we never blank out a real paragraph.
  for (const [index, value] of replacements) {
    if (!value.trim()) replacements.delete(index);
  }

  const checklist = extractLooseJson<ChecklistItem[]>(checklistRaw);
  return {
    replacements,
    coverLetter,
    checklist: Array.isArray(checklist) ? checklist : []
  };
}

function firstAfter(from: number, candidates: number[], fallback: number) {
  const after = candidates.filter((position) => position > from);
  return after.length ? Math.min(...after) : fallback;
}

async function runLlmGuarded(request: Parameters<typeof runLlm>[0]) {
  try {
    return await runLlm(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI generation error";
    if (/401|unauthorized|user not found|invalid api key/i.test(message)) {
      throw new Error("OpenRouter rejected the API key or account for document generation. Re-save a valid OpenRouter key in Settings, then try Prepare Materials again.");
    }
    throw error;
  }
}

const TEMPLATE_SYSTEM_PROMPT =
  "You convert a candidate's real CV into structured JSON and tailor it to one job.\n\n" +
  "FAITHFULNESS (most important): Keep the candidate's real professional identity, role, employers, dates, and facts exactly. Do NOT rebrand them into a different profession or invent employers, titles, degrees, dates, certificates, tools, or skills. Only reorder and rephrase real content to emphasize what is most relevant to this job.\n" +
  "STRICT — no new tools/skills: Do NOT add any tool, technology, framework, library, certification, or skill that is not LITERALLY written in the candidate's materials — not even closely related ones (e.g. do NOT add 'Anthropic' just because 'OpenAI' is present; do NOT add 'Terraform', 'AWS', 'Kubernetes', or '-ready'/'-capable'/'-friendly' qualifiers). Copy skill names and tech-stack items verbatim from the source; never expand, infer, round up, or pad a list. The same rule applies to the summary, headline, and stats. If a job wants a tool the candidate lacks, put it in the checklist as 'missing' — never in the CV.\n\n" +
  "Respond with EXACTLY these three sections, each starting with its marker on its own line, and nothing else:\n\n" +
  CV_JSON_MARKER + "\n" +
  "A single valid JSON object with this shape:\n" +
  '{ "name": string, "headline": string, "contact": string[], "stats": [{"value": string, "label": string}], "summary": string, "sections": [ { "heading": string, "type": "...", ...fields } ] }\n' +
  "Section types and their fields:\n" +
  '  - "pills":      { "pills": string[] }            // short items joined inline, e.g. clients / sectors\n' +
  '  - "bullets":    { "bullets": [{"lead"?: string, "text": string}] }   // impact points, certifications\n' +
  '  - "techstack":  { "rows": [{"label": string, "value": string}] }     // skills grouped by category\n' +
  '  - "experience": { "entries": [{"title": string, "meta"?: string, "bullets": [{"lead"?: string, "text": string}]}] }   // jobs AND education\n' +
  '  - "projects":   { "entries": [{"title": string, "description": string, "tags"?: string}] }\n' +
  '  - "languages":  { "items": [{"label": string, "value"?: string}] }\n' +
  "Include the candidate's real sections (e.g. clients/sectors, impact, skills/tech stack, experience, selected projects, education, certifications, languages). 3-4 short stats tiles. Keep it strictly valid JSON.\n\n" +
  COVER_MARKER + "\n" +
  "A concise, specific cover letter as plain text. Only reference real experience.\n\n" +
  CHECKLIST_MARKER + "\n" +
  'A valid JSON array; each item is {"requirement": string, "status": "met"|"missing"|"address", "evidence": string, "plan": string}.';

// Template mode: extract the candidate's real CV into a StructuredCv and tailor
// it for the job in one call (CV as JSON, cover letter as plain text, checklist
// as JSON) so the gallery template can render it.
async function generateTemplateCv(input: {
  model: string;
  baseCv: unknown;
  supportingMaterials: SupportingMaterial[];
  job: JobContext;
  instructions?: string;
}): Promise<{ cv: StructuredCv; coverLetter: string; checklist: ChecklistItem[] }> {
  const baseText = typeof (input.baseCv as { rawText?: unknown })?.rawText === "string"
    ? (input.baseCv as { rawText: string }).rawText
    : JSON.stringify(input.baseCv);

  const userPayload = [
    `JOB TITLE: ${input.job.title}`,
    `COMPANY: ${input.job.company}`,
    `LOCATION: ${input.job.location ?? "Not specified"}`,
    "",
    "JOB DESCRIPTION:",
    input.job.description,
    "",
    "SUPPORTING MATERIALS (facts about the candidate, evidence only):",
    JSON.stringify(input.supportingMaterials),
    "",
    `USER INSTRUCTIONS: ${input.instructions || "(none)"}`,
    "",
    "CANDIDATE CV (extract the real content from this; never invent):",
    baseText
  ].join("\n");

  const response = await runLlmGuarded({
    model: input.model,
    responseFormat: "text",
    maxTokens: 8000,
    messages: [
      { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
      { role: "user", content: userPayload }
    ]
  });

  return parseTemplateResponse(response, baseText);
}

function parseTemplateResponse(response: string, baseText: string) {
  const text = response?.trim() ?? "";
  const cvIdx = text.indexOf(CV_JSON_MARKER);
  const coverIdx = text.indexOf(COVER_MARKER);
  const checklistIdx = text.indexOf(CHECKLIST_MARKER);

  const cvBlock = cvIdx >= 0
    ? text.slice(cvIdx + CV_JSON_MARKER.length, firstAfter(cvIdx, [coverIdx, checklistIdx], text.length))
    : text;
  const coverLetter = coverIdx >= 0
    ? text.slice(coverIdx + COVER_MARKER.length, firstAfter(coverIdx, [checklistIdx], text.length)).trim()
    : "";
  const checklistRaw = checklistIdx >= 0 ? text.slice(checklistIdx + CHECKLIST_MARKER.length) : "";

  const parsedCv = extractLooseJson<StructuredCv>(cvBlock);
  const cv = isStructuredCv(parsedCv) ? normalizeStructuredCv(parsedCv) : fallbackStructuredCv(baseText);
  const checklist = extractLooseJson<ChecklistItem[]>(checklistRaw);

  return {
    cv,
    coverLetter: stripFences(coverLetter),
    checklist: Array.isArray(checklist) ? checklist : []
  };
}

function normalizeStructuredCv(cv: StructuredCv): StructuredCv {
  return {
    name: String(cv.name || "").trim() || "Candidate",
    headline: cv.headline ? String(cv.headline) : undefined,
    contact: toStringArray(cv.contact),
    stats: Array.isArray(cv.stats)
      ? cv.stats.filter((s) => s && s.value).map((s) => ({ value: String(s.value), label: s.label ? String(s.label) : undefined }))
      : [],
    summary: cv.summary ? String(cv.summary) : undefined,
    sections: Array.isArray(cv.sections) ? cv.sections : []
  };
}

function fallbackStructuredCv(baseText: string): StructuredCv {
  const lines = baseText.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    name: lines[0] || "Candidate",
    sections: [{ heading: "Profile", type: "bullets", bullets: lines.slice(1, 40).map((text) => ({ text })) }]
  };
}

function flattenStructuredCv(cv: StructuredCv): string {
  const lines: string[] = [cv.name];
  if (cv.headline) lines.push(cv.headline);
  if (cv.contact?.length) lines.push(cv.contact.join("  ·  "));
  if (cv.stats?.length) lines.push(cv.stats.map((s) => `${s.value}${s.label ? ` (${s.label})` : ""}`).join("  ·  "));
  if (cv.summary) lines.push("", cv.summary);
  for (const section of cv.sections ?? []) {
    lines.push("", section.heading.toUpperCase());
    if (section.type === "pills") {
      lines.push((section.pills ?? []).join("  ·  "));
    } else if (section.type === "techstack") {
      for (const row of section.rows ?? []) lines.push(`${row.label}: ${row.value}`);
    } else if (section.type === "experience") {
      for (const entry of section.entries ?? []) {
        lines.push(entry.title + (entry.meta ? `  ·  ${entry.meta}` : ""));
        for (const bullet of entry.bullets ?? []) lines.push(`  • ${bullet.lead ? `${bullet.lead} — ` : ""}${bullet.text}`);
      }
    } else if (section.type === "projects") {
      for (const entry of section.entries ?? []) {
        lines.push(entry.title);
        if (entry.description) lines.push(`  ${entry.description}`);
        if (entry.tags) lines.push(`  ${entry.tags}`);
      }
    } else if (section.type === "languages") {
      lines.push((section.items ?? []).map((i) => `${i.label}${i.value ? ` ${i.value}` : ""}`).join("  ·  "));
    } else {
      for (const bullet of section.bullets ?? []) lines.push(`• ${bullet.lead ? `${bullet.lead} — ` : ""}${bullet.text}`);
    }
  }
  return lines.join("\n");
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

async function generateDocuments(input: {
  model: string;
  baseCv: unknown;
  supportingMaterials: Array<{
    label: string;
    source?: string | null;
    content: unknown;
  }>;
  job: {
    title: string;
    company: string;
    location?: string | null;
    description: string;
    url: string;
  };
  instructions?: string;
}): Promise<PreparationResponse> {
  try {
    // We deliberately ask for the CV and cover letter as plain text between
    // markers (not embedded inside JSON). Models routinely fail to escape the
    // quotes/newlines inside a large CV string, which produced invalid JSON and
    // broke every preparation. Only the small checklist is requested as JSON.
    const response = await runLlm({
      model: input.model,
      responseFormat: "text",
      maxTokens: 8000,
      messages: [
        {
          role: "system",
          content:
            "You tailor job application materials for one candidate to one job.\n\n" +
            "FAITHFULNESS (most important): Keep the candidate's real professional identity, headline, and career exactly as in baseCvTemplate. Do NOT rebrand them into a different profession or invent a new role title to match the job (for example, never relabel a petroleum / AI-automation engineer as a 'UI/UX Engineer'). Use only facts found in baseCvTemplate and supportingMaterials. Never invent or imply employers, job titles, degrees, dates, certificates, tools, skills, or experience the candidate does not already have. If the job needs something the candidate lacks, record it in the checklist with status \"missing\" or \"address\" — never add it to the CV or cover letter.\n\n" +
            "Respond with EXACTLY these three sections, each starting with its marker on its own line, in this order, and nothing before, between, or after them except the section content:\n\n" +
            `${CV_MARKER}\n` +
            "The candidate's CV, keeping the SAME language, section order, headings, tone, wording style, professional identity, and overall layout as baseCvTemplate (if it has rawText, mirror that text's structure). Reorder and rephrase only to emphasize the candidate's REAL, existing achievements most relevant to this job. Make minimal changes; do not introduce a new persona. Output as plain text only.\n\n" +
            `${COVER_MARKER}\n` +
            "A concise, specific cover letter for this job, as plain text. Only reference real experience from the materials; do not fabricate roles, projects, or skills.\n\n" +
            `${CHECKLIST_MARKER}\n` +
            'A valid JSON array. Each element is an object with keys: "requirement" (string), "status" (one of "met", "missing", "address"), "evidence" (string), "plan" (string). Cover the important requirements in the job description.'
        },
        {
          role: "user",
          content: JSON.stringify({
            baseCvTemplate: input.baseCv,
            supportingMaterials: input.supportingMaterials,
            job: input.job,
            userInstructions: input.instructions || ""
          })
        }
      ]
    });

    return parsePreparationResponse(response, input.baseCv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI generation error";
    if (/401|unauthorized|user not found|invalid api key/i.test(message)) {
      throw new Error("OpenRouter rejected the API key or account for document generation. Re-save a valid OpenRouter key in Settings, then try Prepare Materials again.");
    }
    throw error;
  }
}

function parsePreparationResponse(response: string, baseCv: unknown): PreparationResponse {
  const text = response?.trim() ?? "";
  if (!text) {
    throw new Error("The model returned an empty response. Try again or choose a stronger OpenRouter model for Tailor Model.");
  }

  const cvIdx = text.indexOf(CV_MARKER);
  const coverIdx = text.indexOf(COVER_MARKER);
  const checklistIdx = text.indexOf(CHECKLIST_MARKER);

  // Slice each section between its marker and the start of the next present marker.
  const cvText = sliceSection(text, cvIdx + CV_MARKER.length, [coverIdx, checklistIdx]);
  const coverLetter = coverIdx >= 0
    ? sliceSection(text, coverIdx + COVER_MARKER.length, [checklistIdx])
    : "";
  const checklistRaw = checklistIdx >= 0 ? text.slice(checklistIdx + CHECKLIST_MARKER.length) : "";

  // If the markers were not produced at all, fall back to using the whole reply
  // as the CV so the user still gets a usable draft instead of a hard error.
  const tailoredCvText = cvIdx >= 0 ? cvText : stripFences(text);
  const checklist = extractLooseJson<ChecklistItem[]>(checklistRaw);

  return {
    tailoredCv: buildTailoredCv(baseCv, tailoredCvText),
    coverLetter: stripFences(coverLetter),
    checklist: Array.isArray(checklist) ? checklist : []
  };
}

function sliceSection(text: string, from: number, nextMarkerPositions: number[]) {
  const ends = nextMarkerPositions.filter((position) => position > from);
  const to = ends.length ? Math.min(...ends) : text.length;
  return stripFences(text.slice(from, to));
}

function stripFences(value: string) {
  return value
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
}

// Keep the tailored CV in the same shape as the base CV (rawText-based for
// imported PDFs/DOCX, otherwise a structured object) so the rest of the app and
// the UI render it consistently.
function buildTailoredCv(baseCv: unknown, cvText: string) {
  if (baseCv && typeof baseCv === "object") {
    return { ...(baseCv as Record<string, unknown>), rawText: cvText };
  }
  return { rawText: cvText, basics: {}, experience: [], education: [], skills: [] };
}

async function nextCvVersion(cvKey: string) {
  const latest = await prisma.cvVersion.findFirst({
    where: { cvKey },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  return (latest?.version || 0) + 1;
}

async function readTemplateCv() {
  const setting = await prisma.appSetting.findUnique({ where: { key: "templateCvVersionId" } });
  if (setting) {
    const selected = await prisma.cvVersion.findUnique({ where: { id: setting.value } });
    if (selected) return selected;
  }

  // Fallback to the most recent USER-IMPORTED CV. Never fall back to a previously
  // generated (tailored:) CV, or each prepare would re-tailor its own output and
  // the candidate's identity would drift away from the real base CV.
  return prisma.cvVersion.findFirst({
    where: { NOT: { source: { startsWith: "tailored:" } } },
    orderBy: { createdAt: "desc" }
  });
}

async function readSupportingMaterials() {
  return prisma.cvVersion.findMany({
    where: {
      includeEvidence: true,
      NOT: {
        source: {
          startsWith: "tailored:"
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
}
