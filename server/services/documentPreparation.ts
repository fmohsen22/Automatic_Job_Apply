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
import { buildDocxFromStructuredCv, buildDocxFromText } from "./wordExport.js";
import { fromJsonString, toJsonString } from "../utils/json.js";
import { extractLooseJson } from "../utils/llmJson.js";

const CV_MARKER = "<<<TAILORED_CV>>>";
const COVER_MARKER = "<<<COVER_LETTER>>>";
const CHECKLIST_MARKER = "<<<CHECKLIST_JSON>>>";
const SEGMENTS_MARKER = "<<<CV_SEGMENTS>>>";
const CV_JSON_MARKER = "<<<CV_JSON>>>";

// Guidance that makes the tailored CV thorough and recruiter-ready (tech-resume
// best practice) WITHOUT ever loosening the faithfulness rules above it — detail
// must always trace back to the candidate's real materials, never be invented.
const DETAIL_GUIDANCE =
  "COMPLETENESS & DETAIL (tech-resume best practice — write a strong, thorough CV, never a sparse one): Draw out ALL of the candidate's real, relevant experience from the CV and supporting materials. A single page is fine only when that is genuinely all the real content supports; otherwise use up to TWO full pages rather than dropping real, relevant detail.\n" +
  "MANDATORY SECTION CHECKLIST — include every one of these the candidate's REAL materials support (a professional tech resume is incomplete without them):\n" +
  "  1. Name + contact including LOCATION (city, country), phone, email.\n" +
  "  2. Professional summary: 1-3 sentences — title, sector, key skills/credentials, experience overview.\n" +
  "  3. Relevant LINKS: LinkedIn / GitHub / portfolio, whenever they appear in the materials.\n" +
  "  4. TOOLS / TECH STACK: a dedicated section listing the candidate's real languages, frameworks, tools and platforms grouped by category — separate from soft skills.\n" +
  "  5. SKILLS: focused, quality over quantity; avoid generic 'experience with' phrasing.\n" +
  "  6. WORK EXPERIENCE: for EACH real role 3-6 specific bullets, each starting with a strong action verb (Built, Automated, Led, Reduced, Designed, Delivered…) and carrying the real metric or outcome whenever the materials provide one (numbers, %, time saved, scale, users). Never compress a rich role into one or two vague lines.\n" +
  "  7. PROJECTS / selected work: real projects with impact and technologies.\n" +
  "  8. EDUCATION: relevant degrees with institution and year.\n" +
  "  9. CERTIFICATIONS and 10. LANGUAGES (with the candidate's real proficiency levels, verbatim).\n" +
  "KEYWORDS: mirror the exact terminology of the job description wherever the candidate genuinely has that skill (recruiters and ATS scanners match those words). Prefer specific and concrete over generic; every detail must trace back to the materials — more detail must never mean invented detail.\n\n";

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
  const reviewModel = (settings.reviewModel || "").trim();
  const jobContext: JobContext = {
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.descr,
    url: job.url
  };
  // Every material is considered: duplicates (same contentHash) collapse to the
  // newest copy, and if the full set exceeds the prompt budget a cheap model
  // reads ALL of them and ranks what matters for THIS job — nothing is dropped
  // silently.
  const materialSelection = await chooseSupportingMaterials(
    supportingMaterials,
    templateCv.id,
    jobContext,
    reviewModel || settings.searchModel || model
  );
  const supporting = materialSelection.supporting;

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
  let structuredCv: StructuredCv | null = null;
  let formatMode: string;
  const usedTemplateId = gallery?.id ?? null;

  if (gallery?.kind === "html") {
    const result = await generateTemplateCv({ model, reviewModel, baseCv, supportingMaterials: supporting, job: jobContext, instructions });
    templateHtml = gallery.render(result.cv);
    structuredCv = result.cv;
    tailoredCvJson = { ...(result.cv as unknown as Record<string, unknown>), rawText: flattenStructuredCv(result.cv) };
    coverLetter = result.coverLetter;
    checklist = result.checklist;
    formatMode = "template";
  } else if (gallery?.kind === "docx") {
    const fill = await fillTemplateDocx({
      model,
      reviewModel,
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
      reviewModel,
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
    const generated = await generateDocuments({ model, reviewModel, baseCv, supportingMaterials: supporting, job: jobContext, instructions });
    tailoredCvJson = (generated.tailoredCv as Record<string, unknown>) ?? baseCv;
    coverLetter = generated.coverLetter || "";
    checklist = Array.isArray(generated.checklist) ? generated.checklist : [];
    formatMode = "text";
    // Plain-text mode still gets an editable Word file built from the tailored text.
    const cvText = typeof tailoredCvJson.rawText === "string" ? tailoredCvJson.rawText : "";
    if (cvText.trim()) {
      try {
        tailoredDocx = await buildDocxFromText(cvText);
      } catch {
        tailoredDocx = null; // Never fail the whole preparation over the Word export.
      }
    }
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
    // HTML-template mode also gets an editable Word version of the same content.
    let cvDocxPath: string | null = null;
    if (structuredCv) {
      try {
        cvDocxPath = path.join(dir, "cv.docx");
        await writeStoredFile(cvDocxPath, await buildDocxFromStructuredCv(structuredCv));
      } catch {
        cvDocxPath = null; // Word export is best-effort; keep the HTML/PDF output.
      }
    }
    docSet = await prisma.docSet.update({
      where: { id: docSet.id },
      data: { cvHtmlPath, cvPdfPath, cvDocxPath },
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
      materialsUnique: materialSelection.total,
      materialsUsed: materialSelection.used,
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
  reviewModel?: string;
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
  const baseText = candidates.map((segment) => segment.text).join("\n");

  const runTailor = async (extraInstruction: string) => {
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
      `USER INSTRUCTIONS: ${input.instructions || "(none)"}${extraInstruction}`,
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
            "FAITHFULNESS (most important): Use ONLY facts present in the CV segments and supporting materials. Keep the candidate's real professional identity, headline, and career exactly as written. Do NOT rebrand them into a different profession or invent a new role title to match the job (for example, never relabel a petroleum / AI-automation engineer as a 'UI/UX Engineer'). NEVER invent or imply employers, job titles, dates, degrees, certificates, tools, skills, metrics, or achievements the candidate does not already have in the materials — do not add tool names, product names, or '-style' analogies that are not literally in the materials. Rephrasing, reordering, and emphasizing REAL facts is allowed; fabricating is not. If the job requires something the candidate lacks, record it in the checklist as \"missing\" or \"address\" — never add it to the CV or cover letter.\n\n" +
            "The CV is given as numbered text segments (one per paragraph). Rewrite the wording of segments to be more detailed, specific, and quantified where the candidate's real materials support it (expand thin bullets into fuller ones using real facts), while keeping the layout, name, contact details, dates, and company names unchanged. Keep each rewritten segment on a SINGLE line. If a segment should stay as-is, leave it out of your output. Do NOT insert any <<<MARKER>>> tokens or new section headers into a segment.\n\n" +
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
    return parseDocxResponse(response, segments);
  };
  const cvTextOf = (parsed: { replacements: Map<number, string> }) =>
    segments.map((segment) => parsed.replacements.get(segment.index) ?? segment.text).filter((line) => line.trim().length > 0).join("\n");

  const sourceForReview = `${baseText}\n\nEVIDENCE MATERIALS:\n${JSON.stringify(input.supportingMaterials)}`;
  let parsed = await runTailor("");
  for (let attempt = 0; attempt < 2; attempt++) {
    const critique = await unsupportedCritique(input.reviewModel || "", input.model, sourceForReview, input.job, cvTextOf(parsed));
    if (!critique) break;
    parsed = await runTailor(`\n\nCRITICAL FAITHFULNESS FIX — the following were flagged as unsupported/invented. Do NOT include them or anything like them; use ONLY facts present in the candidate's real materials:\n${critique}`);
  }

  const replacements = parsed.replacements;
  const docxBuffer = replacements.size
    ? applyDocxReplacements(input.originalDocx, replacements)
    : input.originalDocx;

  return {
    docxBuffer,
    cvText: cvTextOf(parsed),
    coverLetter: parsed.coverLetter,
    checklist: parsed.checklist
  };
}

const TEMPLATE_FILL_SYSTEM_PROMPT =
  "You fill a CV template with a candidate's real content, tailored to one job.\n\n" +
  "You are given the template as numbered SLOTS, each currently holding SAMPLE text (a fake person's details). For EACH slot, infer its purpose from the sample (name, job title, contact line, section heading, summary, a job entry, a bullet, a skill, education, etc.) and replace it with the CANDIDATE'S real, job-tailored content that fits that slot. Replace ALL sample names, contacts, companies and details with the candidate's real ones. Keep pure section HEADINGS (like 'Experience', 'Education', 'Skills') unchanged. Keep each slot's length similar to its sample so the layout still fits.\n\n" +
  "FAITHFULNESS (most important): Use ONLY facts from the candidate's real CV and supporting materials. NEVER invent employers, job titles, dates, degrees, certificates, tools, skills, metrics, or achievements. Never write a specific product, tool, brand, or framework name (e.g. n8n, Zapier, Docker, AWS) unless that exact name appears in the candidate's materials — and never use it as a '-style' analogy either. Rephrasing, reordering, and emphasizing REAL facts is allowed; fabricating is not. If the job requires something the candidate lacks, record it in the checklist as \"missing\" or \"address\" — never put it in the CV or cover letter. If the template has more slots than the candidate has real content, reuse or condense the candidate's real content sensibly — never fabricate. If a slot has no matching real content, use the closest real content or leave it unchanged.\n\n" +
  "DETAIL vs FIT (both matter): Within each slot, use the candidate's strongest, most specific real content — concrete achievements with real metrics and the actual tools/technologies named in their materials, never vague filler. BUT this is a FIXED one-page design: keep EVERY slot AT OR UNDER its sample text's length — if a slot's content would run longer than its sample, trim the least job-relevant detail instead of letting it grow. Overflowing slots push later sections (Education, Certifications) off the page, which is worse than a shorter bullet. LATER SECTIONS ARE MANDATORY: Education, certifications, and languages slots must always keep real content — never sacrifice them for longer bullets. For a longer, more detailed CV the candidate can pick the Navy / Energy template or the Word output.\n\n" +
  "LANGUAGES: Copy the candidate's real language proficiency levels VERBATIM from their materials (e.g. 'German — Full Professional Proficiency', 'Persian — Native'). NEVER upgrade a level — never call someone a native or fluent speaker of a language their materials don't literally state at that level, no matter what language the job posting is written in.\n\n" +
  "Respond with EXACTLY these three sections, each starting with its marker on its own line:\n\n" +
  SEGMENTS_MARKER + "\n" +
  "One line per slot you fill, in the form: @@<number>@@ <new text>  (use the numbers shown; output a line for every slot that should change).\n\n" +
  COVER_MARKER + "\n" +
  "A concise, specific cover letter as plain text, using real experience only.\n\n" +
  CHECKLIST_MARKER + "\n" +
  'A valid JSON array; each item is {"requirement": string, "status": "met"|"missing"|"address", "evidence": string, "plan": string}.';

// Pour the candidate's tailored content into a designed .docx template (whose
// slots currently hold sample text), keeping the template's exact layout.
// Deterministic guard: brand/tool-looking tokens (contain a digit or inner
// capitals, e.g. n8n, HubSpot, GPT-4) that the JOB description mentions and the
// tailored CV adopted, but that appear NOWHERE in the candidate's materials.
// This is the classic fabrication pattern — the model mirrors a required tool
// from the job ad the candidate doesn't have.
function leakedJobTerms(jobDescription: string, sourceMaterials: string, cvText: string): string[] {
  const tokens = new Set(
    (jobDescription.match(/\b[A-Za-z][A-Za-z0-9.+#-]{2,}\b/g) || []).filter(
      (token) => /\d/.test(token) || /^[a-z]+[A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token)
    )
  );
  const source = sourceMaterials.toLowerCase();
  const tailored = cvText.toLowerCase();
  return [...tokens].filter((token) => {
    const needle = token.toLowerCase();
    return tailored.includes(needle) && !source.includes(needle);
  });
}

// Deterministic guard: native/bilingual-level language claims the candidate's
// materials don't literally support (models upgrade "professional German" to
// "Muttersprache" when the job ad is German — in any language, so a plain
// regex, not the reviewer, has to catch it).
function unsupportedNativeClaims(sourceMaterials: string, cvText: string): string[] {
  const languages = ["german", "deutsch", "english", "englisch", "french", "französisch", "spanish", "italian"];
  const nativeWords = "(?:native|bilingual|muttersprache|mother\\s*tongue|c2)";
  const flagged: string[] = [];
  for (const lang of languages) {
    const claim = new RegExp(`\\b${nativeWords}\\b[^.\\n]{0,60}\\b${lang}\\b|\\b${lang}\\b[^.\\n]{0,60}\\b${nativeWords}\\b`, "i");
    if (claim.test(cvText) && !claim.test(sourceMaterials)) flagged.push(lang);
  }
  return flagged;
}

// Ask the cheap reviewer whether the produced CV text contains anything not
// backed by the candidate's real materials, and merge in the deterministic
// job-term leak check. Returns UNSUPPORTED lines (empty string when clean).
async function unsupportedCritique(reviewModel: string, model: string, baseText: string, job: JobContext, cvText: string): Promise<string> {
  if (cvText.trim().length < 40) return "";
  const lines: string[] = [];
  for (const term of leakedJobTerms(job.description, baseText, cvText)) {
    lines.push(`UNSUPPORTED: "${term}" — this comes from the job ad, not the candidate's materials. Remove it everywhere (including "-style" analogies); if it is a real gap, it belongs in the checklist as "missing".`);
  }
  for (const lang of unsupportedNativeClaims(baseText, cvText)) {
    lines.push(`UNSUPPORTED: a native/bilingual-level claim for "${lang}" — the candidate's materials do NOT state that level. Use their real level verbatim from the materials (e.g. "German — Full Professional Proficiency"); the candidate's native language is whatever the materials say it is.`);
  }
  if (reviewModel && reviewModel !== model) {
    const critique = await reviewCvDraft(reviewModel, baseText, job.description, cvText);
    lines.push(...critique.split("\n").filter((line) => /^\s*UNSUPPORTED:/i.test(line)));
  }
  return lines.join("\n").trim();
}

async function fillTemplateDocx(input: {
  model: string;
  reviewModel?: string;
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

  const runFill = async (extraInstruction: string) => {
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
      `USER INSTRUCTIONS: ${input.instructions || "(none)"}${extraInstruction}`,
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
    return parseDocxResponse(response, segments);
  };
  const cvTextOf = (parsed: { replacements: Map<number, string> }) =>
    segments.map((segment) => parsed.replacements.get(segment.index) ?? segment.text).filter((line) => line.trim().length > 0).join("\n");

  // Content slots the model left holding the template's SAMPLE text. Headings
  // legitimately stay; any slot longer than ~3 words must become real content —
  // this guarantees every section the design has (education, languages,
  // certifications…) actually gets filled.
  const unfilledSlots = (result: { replacements: Map<number, string> }) =>
    candidates
      .filter((segment) => segment.text.trim().split(/\s+/).length > 3 && !result.replacements.has(segment.index))
      .map((segment) => segment.index);

  const sourceForReview = `${baseText}\n\nEVIDENCE MATERIALS:\n${JSON.stringify(input.supportingMaterials)}`;
  let parsed = await runFill("");
  for (let attempt = 0; attempt < 2; attempt++) {
    const critique = await unsupportedCritique(input.reviewModel || "", input.model, sourceForReview, input.job, cvTextOf(parsed));
    const missing = unfilledSlots(parsed);
    if (!critique && !missing.length) break;
    const fixes: string[] = [];
    if (critique) fixes.push(`CRITICAL FAITHFULNESS FIX — the following were flagged as unsupported/invented. Do NOT include them or anything like them; use ONLY facts present in the candidate's real materials:\n${critique}`);
    if (missing.length) fixes.push(`COMPLETENESS FIX — these slots still contain the template's sample text: ${missing.map((index) => `@@${index}@@`).join(", ")}. Fill EVERY one of them with the candidate's real content (condense or reuse real facts where needed — the sample person's text must never remain in the final CV).`);
    parsed = await runFill(`\n\n${fixes.join("\n\n")}`);
  }

  const replacements = parsed.replacements;
  const docxBuffer = replacements.size
    ? applyDocxReplacements(input.templateDocx, replacements)
    : input.templateDocx;
  return { docxBuffer, cvText: cvTextOf(parsed), coverLetter: parsed.coverLetter, checklist: parsed.checklist };
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
  // Strip any stray <<<MARKER>>> tokens the model may have invented inside a
  // rewritten paragraph (e.g. a made-up <<<PROJECTS_SECTION>>>), then drop no-op
  // or emptied replacements so we never blank out a real paragraph.
  for (const [index, value] of replacements) {
    const cleaned = value.replace(/<<<[^>]*>>>/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!cleaned) replacements.delete(index);
    else if (cleaned !== value) replacements.set(index, cleaned);
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
  "FAITHFULNESS (most important): Use ONLY facts present in the candidate's CV and supporting materials. Keep the candidate's real professional identity, role, employers, dates, and facts exactly. Do NOT rebrand them into a different profession or invent employers, titles, dates, degrees, certificates, tools, skills, metrics, or achievements. Reordering and rephrasing real content to emphasize what is most relevant to this job is allowed; fabricating is not.\n" +
  "SOURCES ARE EQUAL: The candidate's CV and the SUPPORTING MATERIALS are equally valid sources of real facts. The materials are often NEWER than the base CV — roles, projects, certifications, and skills that appear only in the supporting materials are REAL and MUST be included when relevant to the job; adding them is required, not fabrication. When the evidence describes a role as the candidate's own position at a company that the base CV frames only as a client or consultancy assignment, follow the NEWER evidence: list it as its own experience entry with its dates. Order experience newest first; the candidate's current role leads the section.\n" +
  "USER INSTRUCTIONS ARE BINDING: whatever the USER INSTRUCTIONS say about which roles, projects, dates, or emphasis to include is a hard requirement (as long as it is consistent with the materials) — never silently ignore them.\n" +
  "STRICT — no new tools/skills: Do NOT add any tool, technology, framework, library, product, brand, certification, or skill that is not LITERALLY written in the candidate's materials — not even closely related ones or as a '-style' analogy (e.g. do NOT add 'Anthropic' just because 'OpenAI' is present; do NOT add 'n8n', 'Zapier', 'Terraform', 'AWS', 'Kubernetes', or '-ready'/'-capable'/'-friendly'/'-style' qualifiers). Copy skill names and tech-stack items verbatim from the source; never expand, infer, round up, or pad a list. The same rule applies to the summary, headline, and stats. If the job requires a tool or qualification the candidate lacks, put it in the checklist as 'missing' or 'address' — never in the CV or cover letter.\n\n" +
  DETAIL_GUIDANCE +
  "Respond with EXACTLY these three sections, each starting with its marker on its own line, and nothing else:\n\n" +
  CV_JSON_MARKER + "\n" +
  "A single valid JSON object with this shape:\n" +
  '{ "name": string, "headline": string, "contact": string[], "stats": [{"value": string, "label": string}], "summary": string, "sections": [ { "heading": string, "type": "...", ...fields } ] }\n' +
  "Section types and their fields:\n" +
  '  - "pills":      { "pills": string[] }            // short items joined inline, e.g. clients / sectors\n' +
  '  - "bullets":    { "bullets": [{"lead"?: string, "text": string}] }   // impact points, certifications\n' +
  '  - "techstack":  { "rows": [{"label": string, "value": string}] }     // TOOLS / TECH STACK grouped by category (Languages, Test Automation, CI/CD, Cloud…)\n' +
  '  - "experience": { "entries": [{"title": string, "meta"?: string, "bullets": [{"lead"?: string, "text": string}]}] }   // jobs AND education; 3-6 detailed bullets per real role\n' +
  '  - "projects":   { "entries": [{"title": string, "description": string, "tags"?: string}] }   // real projects with their impact/metrics\n' +
  '  - "languages":  { "items": [{"label": string, "value"?: string}] }\n' +
  "Build a COMPLETE CV from the candidate's real content: put contact/links in \"contact\"; a professional \"summary\"; 3-4 real \"stats\" tiles; a \"techstack\" TOOLS section grouping their real tools; a rich \"experience\" section with 3-6 substantive bullets per role; a \"projects\" section for real selected work; plus education, certifications, and languages when present. Keep it strictly valid JSON.\n\n" +
  COVER_MARKER + "\n" +
  "A concise, specific cover letter as plain text. Only reference real experience.\n\n" +
  CHECKLIST_MARKER + "\n" +
  'A valid JSON array; each item is {"requirement": string, "status": "met"|"missing"|"address", "evidence": string, "plan": string}.';

// Deterministic tech-resume completeness gate (CareerFoundry-derived): checks a
// structured CV for the mandatory sections the candidate's materials actually
// support. Anything missing forces one corrective regeneration — completeness
// is enforced by code, not left to the model's mood.
function guideGaps(cv: StructuredCv, source: string): string[] {
  const gaps: string[] = [];
  const sections = cv.sections ?? [];
  const headings = sections.map((section) => section.heading.toLowerCase()).join(" | ");
  const types = new Set(sections.map((section) => section.type));
  const contact = (cv.contact ?? []).join(" ");

  if (!types.has("techstack")) gaps.push('a dedicated TOOLS / TECH STACK section (type "techstack") grouping the candidate\'s real tools by category');
  const experience = sections.find((section) => section.type === "experience" && /experience|work|history|berufserfahrung/i.test(section.heading));
  if (!experience || !(experience.entries ?? []).length) {
    gaps.push("a WORK EXPERIENCE section with the candidate's real roles");
  } else {
    const thin = (experience.entries ?? []).filter((entry) => (entry.bullets ?? []).length < 3);
    if (thin.length) gaps.push(`3-6 substantive bullets for every main role (${thin.length} role(s) currently have fewer than 3)`);
  }
  if (!/education|ausbildung/i.test(headings)) gaps.push("an EDUCATION section (degrees with institution and year)");
  if (/istqb|ireb|tricentis|certificat|certified/i.test(source) && !/certif|accomplish|qualification/i.test(headings)) {
    gaps.push("a CERTIFICATIONS section — the materials contain real certifications (e.g. ISTQB/IREB/Tricentis)");
  }
  if (/languages?\b|english|german|persian|deutsch|farsi/i.test(source) && !types.has("languages") && !/language|sprachen/i.test(headings)) {
    gaps.push("a LANGUAGES section with the candidate's real proficiency levels, verbatim from the materials");
  }
  if (/linkedin|github/i.test(source) && !/linkedin|github/i.test(contact)) {
    gaps.push("the candidate's LinkedIn/GitHub link in the contact lines (it is present in the materials)");
  }
  if (/wohni|claraven/i.test(source) && !types.has("projects") && !/project/i.test(headings)) {
    gaps.push("a PROJECTS section for the candidate's real selected projects");
  }
  if (!/vienna|wien|\d{4}\s|austria/i.test(contact) && /vienna|wien|austria/i.test(source)) {
    gaps.push("the candidate's location (city, country) in the contact lines");
  }
  // Recency: the CV's newest year must not lag the materials' newest year —
  // otherwise the candidate's most recent role/projects were dropped (models
  // tend to trust the older base CV over newer evidence).
  const maxYear = (text: string) => Math.max(0, ...(text.match(/20[12]\d/g) ?? []).map(Number));
  const cvYear = maxYear(JSON.stringify(cv));
  const sourceYear = maxYear(source);
  if (sourceYear && cvYear && sourceYear > cvYear) {
    gaps.push(`the candidate's MOST RECENT roles and projects — the materials contain entries up to ${sourceYear} (newer roles/projects in the evidence), but the draft's newest entry is from ${cvYear}. The newest real role must appear first in experience`);
  }
  return gaps;
}

// Template mode: extract the candidate's real CV into a StructuredCv and tailor
// it for the job in one call (CV as JSON, cover letter as plain text, checklist
// as JSON) so the gallery template can render it.
async function generateTemplateCv(input: {
  model: string;
  reviewModel?: string;
  baseCv: unknown;
  supportingMaterials: SupportingMaterial[];
  job: JobContext;
  instructions?: string;
}): Promise<{ cv: StructuredCv; coverLetter: string; checklist: ChecklistItem[] }> {
  const baseText = typeof (input.baseCv as { rawText?: unknown })?.rawText === "string"
    ? (input.baseCv as { rawText: string }).rawText
    : JSON.stringify(input.baseCv);

  const buildPayload = (addendum: string) => [
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
    `USER INSTRUCTIONS: ${input.instructions || "(none)"}${addendum}`,
    "",
    "CANDIDATE CV (extract the real content from this; never invent):",
    baseText
  ].join("\n");

  const generate = async (addendum: string) => {
    const response = await runLlmGuarded({
      model: input.model,
      responseFormat: "text",
      maxTokens: 12000,
      messages: [
        { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
        { role: "user", content: buildPayload(addendum) }
      ]
    });
    return parseTemplateResponse(response, baseText);
  };

  const firstRole = (cv: StructuredCv) => {
    const exp = (cv.sections ?? []).find((s) => s.type === "experience" && /experience|work/i.test(s.heading));
    const entry = (exp?.entries ?? [])[0];
    return entry ? `${entry.title} ${entry.meta ?? ""}` : "(none)";
  };
  const sourceForGaps = `${baseText}\n${JSON.stringify(input.supportingMaterials)}`;
  let parsed = await generate("");
  const gaps = guideGaps(parsed.cv, sourceForGaps);
  if (gaps.length) {
    // One corrective pass: regenerate with the concrete list of what a complete
    // tech resume still needs (only sections the real materials support).
    const retry = await generate(
      `\n\nCOMPLETENESS FIX — your previous draft was missing mandatory sections. Regenerate the FULL response and include, using ONLY real content from the materials:\n- ${gaps.join("\n- ")}`
    );
    if (guideGaps(retry.cv, sourceForGaps).length < gaps.length) parsed = retry;
  }

  const cv = await reviewAndRefineStructured(input.reviewModel || "", input.model, baseText, input.supportingMaterials, input.job, parsed.cv);
  // Refine may improve sections but must never DROP one (e.g. Languages).
  // Restore any pre-refine section that vanished — deterministically.
  const norm = (heading: string) => heading.toLowerCase().replace(/[^a-z]/g, "");
  for (const section of parsed.cv.sections) {
    const uniqueTypes = ["techstack", "projects", "languages", "pills"];
    const sameTypeSurvives = cv.sections.some((existing) => existing.type === section.type);
    const headingSurvives = cv.sections.some((existing) => norm(existing.heading) === norm(section.heading));
    if ((uniqueTypes.includes(section.type) && !sameTypeSurvives) || (!uniqueTypes.includes(section.type) && !headingSurvives)) {
      cv.sections.push(section);
    }
  }
  return { ...parsed, cv };
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

// --- Two-model refinement: a cheap reviewer critiques the draft, then the tailor
// model improves it. Skipped when no (distinct) review model is configured. ---

async function reviewCvDraft(reviewModel: string, baseText: string, jobDescription: string, tailoredText: string): Promise<string> {
  try {
    const response = await runLlm({
      model: reviewModel,
      responseFormat: "text",
      maxTokens: 1400,
      messages: [
        {
          role: "system",
          content:
            "You are a sharp CV reviewer. Compare the candidate's ORIGINAL CV and the TAILORED CV against the JOB. " +
            "Give concrete improvement notes: stronger wording, better ordering, conciseness, and keywords from the job description. " +
            "CRUCIAL — truthfulness check first: verify every employer, job title, date, degree, certificate, tool, skill, metric, and achievement in the TAILORED CV against the ORIGINAL CV. In particular: (a) list every specific product / tool / technology / framework / brand name that appears in the TAILORED CV (e.g. n8n, Zapier, Docker, AWS) and, for each one NOT written verbatim in the ORIGINAL CV, output a line 'UNSUPPORTED: <name>' — including names used as an analogy or with a '-style' suffix; (b) check every LANGUAGE PROFICIENCY claim (native / bilingual / fluent / C1 / Muttersprache …) — if the TAILORED CV states a higher level than the ORIGINAL CV literally does (e.g. 'native German' when the original says 'German — professional proficiency'), flag it 'UNSUPPORTED:' with the correct real level. Flag any other invented or unsupported claim the same way. Rephrased or reordered real facts are fine; new facts are not. " +
            "Then a COMPLETENESS check: if the ORIGINAL CV (or evidence) contains real, relevant experience, tools, projects, achievements, or metrics that are MISSING or under-described in the TAILORED CV, flag each on its own line starting with 'ADD:' naming the real detail to surface (e.g. a real tool to list, a role that needs more bullets, a project to include). A thorough, detailed CV is the goal — flag thinness. Only surface detail that is genuinely in the ORIGINAL CV or evidence; never suggest inventing anything. " +
            "Bullet points only, no preamble. If it is already excellent, faithful, and thorough, reply with exactly: OK."
        },
        { role: "user", content: JSON.stringify({ job: jobDescription.slice(0, 3000), originalCv: baseText.slice(0, 14000), tailoredCv: tailoredText.slice(0, 8000) }) }
      ]
    });
    return response.trim();
  } catch {
    return "";
  }
}

// IMPORTANT: both refine helpers must receive the candidate's FULL source of
// truth (base CV + evidence materials), not just the base CV — otherwise real
// roles/projects that exist only in newer evidence get flagged UNSUPPORTED by
// the reviewer and stripped out of the draft.
function fullSource(baseText: string, materials: SupportingMaterial[]): string {
  return `${baseText}\n\nEVIDENCE MATERIALS (equally valid, often newer facts):\n${JSON.stringify(materials)}`;
}

async function reviewAndRefineText(reviewModel: string, tailorModel: string, baseText: string, materials: SupportingMaterial[], job: JobContext, tailoredText: string): Promise<string> {
  if (!reviewModel || reviewModel === tailorModel || tailoredText.trim().length < 40) return tailoredText;
  const source = fullSource(baseText, materials);
  const critique = await reviewCvDraft(reviewModel, source, job.description, tailoredText);
  if (!critique || /^ok\b/i.test(critique)) return tailoredText;
  try {
    const response = await runLlmGuarded({
      model: tailorModel,
      responseFormat: "text",
      maxTokens: 8000,
      messages: [
        { role: "system", content: "Improve the TAILORED CV using the reviewer's notes. Use ONLY facts present in the ORIGINAL CV + EVIDENCE — never add employers, titles, dates, degrees, certificates, tools, skills, metrics, or achievements not in them (facts appearing only in the evidence are REAL and allowed). REMOVE anything flagged 'UNSUPPORTED'. ADD the real detail flagged with 'ADD:' — expand thin roles into fuller bullets, surface missing real tools/projects — making the CV more thorough and detailed. Keep the same language, headings, and professional identity. Return ONLY the improved CV as plain text — no commentary, no markers." },
        { role: "user", content: `JOB: ${job.title} at ${job.company}\n${job.description.slice(0, 3000)}\n\nORIGINAL CV + EVIDENCE:\n${source.slice(0, 16000)}\n\nCURRENT TAILORED CV:\n${tailoredText}\n\nREVIEWER NOTES:\n${critique}` }
      ]
    });
    const refined = stripFences(response);
    return refined && refined.length >= tailoredText.length * 0.6 ? refined : tailoredText;
  } catch {
    return tailoredText;
  }
}

async function reviewAndRefineStructured(reviewModel: string, tailorModel: string, baseText: string, materials: SupportingMaterial[], job: JobContext, cv: StructuredCv): Promise<StructuredCv> {
  if (!reviewModel || reviewModel === tailorModel) return cv;
  const source = fullSource(baseText, materials);
  const critique = await reviewCvDraft(reviewModel, source, job.description, flattenStructuredCv(cv));
  if (!critique || /^ok\b/i.test(critique)) return cv;
  try {
    const response = await runLlmGuarded({
      model: tailorModel,
      responseFormat: "text",
      maxTokens: 8000,
      messages: [
        { role: "system", content: "Improve this CV (a JSON object) using the reviewer's notes. Use ONLY facts present in the ORIGINAL CV + EVIDENCE — never add employers, titles, dates, degrees, certificates, tools, skills, metrics, or achievements not in them (facts appearing only in the evidence are REAL and allowed). REMOVE anything flagged 'UNSUPPORTED'. ADD the real detail flagged with 'ADD:' — expand thin roles into 3-6 fuller bullets, add a tools/tech-stack section and real projects when the content supports them — making the CV more thorough. Keep the EXACT same JSON shape (same keys and section types). Return ONLY the improved JSON object, nothing else." },
        { role: "user", content: `REVIEWER NOTES:\n${critique}\n\nORIGINAL CV + EVIDENCE:\n${source.slice(0, 16000)}\n\nCURRENT CV JSON:\n${JSON.stringify(cv)}` }
      ]
    });
    const parsed = extractLooseJson<StructuredCv>(response);
    return isStructuredCv(parsed) ? normalizeStructuredCv(parsed) : cv;
  } catch {
    return cv;
  }
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
  reviewModel?: string;
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
            "FAITHFULNESS (most important): Use ONLY facts found in baseCvTemplate and supportingMaterials. Keep the candidate's real professional identity, headline, and career exactly as in baseCvTemplate. Do NOT rebrand them into a different profession or invent a new role title to match the job (for example, never relabel a petroleum / AI-automation engineer as a 'UI/UX Engineer'). NEVER invent or imply employers, job titles, dates, degrees, certificates, tools, skills, metrics, or achievements the candidate does not already have. Rephrasing, reordering, and emphasizing REAL facts is allowed; fabricating is not. If the job needs something the candidate lacks, record it in the checklist with status \"missing\" or \"address\" — never add it to the CV or cover letter.\n\n" +
            DETAIL_GUIDANCE +
            "Respond with EXACTLY these three sections, each starting with its marker on its own line, in this order, and nothing before, between, or after them except the section content:\n\n" +
            `${CV_MARKER}\n` +
            "The candidate's CV, keeping the SAME language, headings style, tone, and professional identity as baseCvTemplate. Surface and elaborate the candidate's REAL, existing achievements most relevant to this job, following the completeness & detail guidance above (detailed experience bullets, a tools/tech section, real projects, links). Do not introduce a new persona or any invented fact. Output as plain text only.\n\n" +
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

    const parsed = parsePreparationResponse(response, input.baseCv);
    const baseText = typeof (input.baseCv as { rawText?: unknown })?.rawText === "string"
      ? (input.baseCv as { rawText: string }).rawText
      : JSON.stringify(input.baseCv);
    const currentText = String((parsed.tailoredCv as { rawText?: unknown })?.rawText ?? "");
    const refinedText = await reviewAndRefineText(input.reviewModel || "", input.model, baseText, input.supportingMaterials, input.job, currentText);
    if (refinedText !== currentText) {
      parsed.tailoredCv = buildTailoredCv(input.baseCv, refinedText);
    }
    return parsed;
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

// Prompt budget for supporting materials (chars of JSON). Everything fits for a
// typical personal corpus; beyond it a cheap model ranks ALL materials by
// relevance to the job and the budget is filled in that order.
const MATERIALS_CHAR_BUDGET = 60_000;

export async function chooseSupportingMaterials(
  materials: Array<{ id: string; label: string; source: string | null; json: string; contentHash: string | null }>,
  templateCvId: string,
  job: JobContext,
  cheapModel: string
): Promise<{ supporting: SupportingMaterial[]; total: number; used: number }> {
  const seen = new Set<string>();
  const unique: Array<SupportingMaterial & { chars: number }> = [];
  for (const material of materials) {
    if (material.id === templateCvId) continue;
    const hashKey = material.contentHash || `id:${material.id}`;
    if (seen.has(hashKey)) continue; // duplicate upload — the newest copy is already in
    seen.add(hashKey);
    const content = fromJsonString(material.json, {});
    unique.push({ label: material.label, source: material.source, content, chars: JSON.stringify(content).length });
  }

  const total = unique.length;
  const strip = ({ label, source, content }: SupportingMaterial) => ({ label, source, content });
  if (unique.reduce((sum, item) => sum + item.chars, 0) <= MATERIALS_CHAR_BUDGET) {
    return { supporting: unique.map(strip), total, used: total };
  }

  let order = unique.map((_, index) => index);
  try {
    const listing = unique
      .map((item, index) => `${index}. [${item.label}${item.source ? ` / ${item.source}` : ""}] ${JSON.stringify(item.content).slice(0, 400)}`)
      .join("\n");
    const response = await runLlm({
      model: cheapModel,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content:
            'You rank a job candidate\'s materials by how useful they are for tailoring a CV to a specific job. Return ONLY a JSON object: {"order": number[]} — every material index exactly once, most relevant first.'
        },
        {
          role: "user",
          content: `JOB: ${job.title} at ${job.company}\n${job.description.slice(0, 3000)}\n\nMATERIALS:\n${listing}`
        }
      ]
    });
    const parsed = extractLooseJson<{ order?: number[] }>(response);
    const valid = (parsed?.order || []).filter((n) => Number.isInteger(n) && n >= 0 && n < unique.length);
    if (valid.length) {
      const missing = order.filter((index) => !valid.includes(index));
      order = [...new Set([...valid, ...missing])];
    }
  } catch {
    // ranking is best-effort — newest-first fallback below still applies
  }

  const chosen: SupportingMaterial[] = [];
  let budget = MATERIALS_CHAR_BUDGET;
  for (const index of order) {
    const item = unique[index];
    if (item.chars <= budget) {
      chosen.push(strip(item));
      budget -= item.chars;
    }
  }
  return { supporting: chosen, total, used: chosen.length };
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
