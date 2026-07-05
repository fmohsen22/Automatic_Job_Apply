/**
 * Generate one PNG preview per CV template into server/templates/previews/<id>.png.
 *
 * There is intentionally NO package.json script for this — run it directly:
 *
 *     npx tsx scripts/render-template-previews.mts
 *
 * Pipeline:
 *   - .docx templates: LibreOffice headless docx -> pdf (same binary lookup as
 *     server/services/documentRender.ts, honoring LIBREOFFICE_PATH), then the
 *     first PDF page -> png via macOS `sips`; falls back to `pdftoppm` if sips
 *     is missing or fails.
 *   - "navy" HTML template: rendered with an obviously-fake sample CV
 *     ("Alex Sample" / sample@example.com) and screenshotted with the
 *     Playwright Chromium the server already depends on.
 *   - Every PNG is downscaled to max width 480px (`sips --resampleWidth 480`)
 *     so the gallery thumbnails load fast.
 *
 * Previews are regenerated in full each run; failures on individual templates
 * do not stop the rest. Exits non-zero if any template ends up without a PNG.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { cvTemplates, docxTemplatePath } from "../server/services/templates.js";
import type { StructuredCv } from "../server/services/cvStructure.js";

// Resolve everything from the repo root so the script works from any cwd
// (docxTemplatePath resolves against process.cwd()).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(REPO_ROOT);

const PREVIEWS_DIR = path.join(REPO_ROOT, "server", "templates", "previews");
const MAX_WIDTH = 480;

// ---------------------------------------------------------------------------
// LibreOffice lookup — mirrors server/services/documentRender.ts (sync version).
// ---------------------------------------------------------------------------

const CANDIDATE_BINARIES = [
  process.env.LIBREOFFICE_PATH,
  // macOS
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/opt/homebrew/bin/soffice",
  // Linux
  "/usr/local/bin/soffice",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  // Windows
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  // PATH fallback (any OS)
  "soffice",
  "libreoffice"
].filter((value): value is string => Boolean(value));

function findLibreOffice(): string | null {
  for (const candidate of CANDIDATE_BINARIES) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      try {
        const real = realpathSync(candidate);
        accessSync(real, constants.X_OK);
        return real;
      } catch {
        continue;
      }
    }
    const found = whichLookup(candidate);
    if (found) return found;
  }
  return null;
}

function whichLookup(command: string): string | null {
  const result = spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const found = result.stdout.trim().split("\n")[0]?.trim();
  return found || null;
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(command: string, args: string[], timeoutMs = 120_000): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: timeoutMs });
  return result.status === 0;
}

function hasCommand(command: string): boolean {
  return whichLookup(command) !== null;
}

// ---------------------------------------------------------------------------
// PDF -> PNG (page 1). Prefer sips (always present on macOS), fall back to
// pdftoppm when available.
// ---------------------------------------------------------------------------

function pdfFirstPageToPng(pdfPath: string, pngPath: string): boolean {
  if (run("/usr/bin/sips", ["-s", "format", "png", pdfPath, "--out", pngPath]) && existsSync(pngPath)) {
    return true;
  }
  if (hasCommand("pdftoppm")) {
    const base = pngPath.replace(/\.png$/i, "");
    if (run("pdftoppm", ["-png", "-r", "96", "-f", "1", "-l", "1", "-singlefile", pdfPath, base]) && existsSync(pngPath)) {
      return true;
    }
  }
  return false;
}

function downscalePng(pngPath: string): void {
  // Best effort — a full-size preview is still a valid preview.
  run("/usr/bin/sips", ["--resampleWidth", String(MAX_WIDTH), pngPath]);
}

// ---------------------------------------------------------------------------
// Sample CV for the HTML template preview. All data is deliberately fake.
// ---------------------------------------------------------------------------

const SAMPLE_CV: StructuredCv = {
  name: "Alex Sample",
  headline: "Senior Project Engineer — Energy & Infrastructure",
  contact: ["sample@example.com", "+1 555 010 0100", "Springfield", "linkedin.com/in/alex-sample"],
  stats: [
    { value: "10+ yrs", label: "Experience" },
    { value: "40+", label: "Projects Delivered" },
    { value: "$25M", label: "Budgets Managed" },
    { value: "12", label: "Team Size Led" }
  ],
  summary:
    "Sample profile text: results-driven engineer with a decade of experience delivering complex projects on time and on budget. This is placeholder content that shows how your tailored CV will look in this design.",
  sections: [
    {
      heading: "Core Competencies",
      type: "pills",
      pills: ["Project Delivery", "Stakeholder Management", "Cost Control", "Risk Analysis", "Contract Negotiation", "Team Leadership"]
    },
    {
      heading: "Technical Stack",
      type: "techstack",
      rows: [
        { label: "Planning", value: "Primavera P6, MS Project, Agile boards" },
        { label: "Engineering", value: "AutoCAD, SAP2000, MATLAB" },
        { label: "Data", value: "Excel modelling, Power BI, SQL" }
      ]
    },
    {
      heading: "Experience",
      type: "experience",
      entries: [
        {
          title: "Senior Project Engineer — Example Energy Co.",
          meta: "Springfield · 2019 – Present",
          bullets: [
            { lead: "Delivery:", text: "Led a portfolio of sample infrastructure projects worth $25M end to end." },
            { lead: "Efficiency:", text: "Cut planning cycle time by 30% by introducing standardised templates." },
            { text: "Coordinated a multidisciplinary team of 12 engineers and contractors." }
          ]
        },
        {
          title: "Project Engineer — Placeholder Industries",
          meta: "Shelbyville · 2014 – 2019",
          bullets: [
            { text: "Managed scope, schedule and budget for mid-size capital projects." },
            { text: "Prepared tender documentation and evaluated supplier bids." }
          ]
        }
      ]
    },
    {
      heading: "Education",
      type: "experience",
      entries: [{ title: "M.Sc. Civil Engineering — Sample University", meta: "2012 – 2014" }]
    },
    {
      heading: "Languages",
      type: "languages",
      items: [
        { label: "English", value: "Fluent" },
        { label: "German", value: "Professional" }
      ]
    }
  ]
};

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

async function renderHtmlPreview(
  render: (cv: StructuredCv) => string,
  pngPath: string
): Promise<void> {
  const html = render(SAMPLE_CV);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    await page.setContent(html, { waitUntil: "networkidle" });
    // Viewport screenshot = top of the page, which is what a thumbnail needs.
    await page.screenshot({ path: pngPath });
  } finally {
    await browser.close();
  }
}

function convertDocxBatchToPdf(soffice: string, docxPaths: string[], outDir: string): void {
  // A private user profile avoids "another instance is running" lock failures.
  const profileDir = path.join(outDir, "lo-profile");
  mkdirSync(profileDir, { recursive: true });
  const baseArgs = [
    `-env:UserInstallation=file://${profileDir}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir
  ];
  // One batch invocation first (fast), then retry stragglers individually.
  run(soffice, [...baseArgs, ...docxPaths], 300_000);
  for (const docxPath of docxPaths) {
    const pdf = path.join(outDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
    if (!existsSync(pdf)) {
      run(soffice, [...baseArgs, docxPath], 120_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(PREVIEWS_DIR, { recursive: true });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "template-previews-"));
  const failures: { id: string; reason: string }[] = [];
  const succeeded: string[] = [];

  try {
    // --- .docx templates -> PDF (one LibreOffice pass) -> PNG ---------------
    const docxTemplates = cvTemplates.filter(
      (t): t is Extract<(typeof cvTemplates)[number], { kind: "docx" }> => t.kind === "docx"
    );
    const soffice = findLibreOffice();
    if (!soffice) {
      for (const t of docxTemplates) failures.push({ id: t.id, reason: "LibreOffice (soffice) not found" });
    } else if (docxTemplates.length > 0) {
      console.log(`Converting ${docxTemplates.length} .docx templates with ${soffice} ...`);
      convertDocxBatchToPdf(soffice, docxTemplates.map((t) => docxTemplatePath(t.file)), tmpDir);

      for (const t of docxTemplates) {
        const pdfPath = path.join(tmpDir, `${path.basename(t.file, path.extname(t.file))}.pdf`);
        const pngPath = path.join(PREVIEWS_DIR, `${t.id}.png`);
        if (!existsSync(pdfPath)) {
          failures.push({ id: t.id, reason: "docx -> pdf conversion failed" });
          continue;
        }
        if (!pdfFirstPageToPng(pdfPath, pngPath)) {
          failures.push({ id: t.id, reason: "pdf -> png conversion failed (sips and pdftoppm)" });
          continue;
        }
        downscalePng(pngPath);
        succeeded.push(t.id);
        console.log(`  ok  ${t.id}.png`);
      }
    }

    // --- HTML templates -> Chromium screenshot ------------------------------
    for (const t of cvTemplates) {
      if (t.kind !== "html") continue;
      const pngPath = path.join(PREVIEWS_DIR, `${t.id}.png`);
      try {
        console.log(`Rendering HTML template "${t.id}" with Chromium ...`);
        await renderHtmlPreview(t.render, pngPath);
        downscalePng(pngPath);
        succeeded.push(t.id);
        console.log(`  ok  ${t.id}.png`);
      } catch (error) {
        failures.push({ id: t.id, reason: `Chromium screenshot failed: ${(error as Error).message}` });
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nGenerated ${succeeded.length}/${cvTemplates.length} previews in ${PREVIEWS_DIR}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAILED ${failure.id}: ${failure.reason}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
