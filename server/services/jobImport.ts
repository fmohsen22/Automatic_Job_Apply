import { writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { createLlmClient, runLlm } from "./llm.js";
import { isCodexModel, runCodex } from "./codexProvider.js";
import { readSettings } from "./settings.js";
import { extractLooseJson } from "../utils/llmJson.js";

// Fetch a job posting the user found and extract title / company / description so
// they can tailor their CV to it. Handles HTML pages (incl. schema.org JobPosting
// structured data), PDF postings, and LinkedIn (via its public guest endpoint —
// public data only, no login). Applying still stays manual on LinkedIn.

export type ExtractedJob = { title: string; company: string; description: string; location?: string };

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchJobPage(url: string, timeoutMs = 15000): Promise<ExtractedJob | null> {
  if (!/^https?:\/\//i.test(url)) return null;

  // LinkedIn job pages bury the description in nav noise; their public guest
  // endpoint returns the clean posting for non-logged-in viewers.
  const linkedInId = linkedInJobId(url);
  if (linkedInId) {
    const fromLinkedIn = await fetchLinkedInJob(linkedInId);
    if (fromLinkedIn) return fromLinkedIn;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf" }
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    const isPdf = contentType.includes("application/pdf") || buffer.subarray(0, 5).toString("latin1") === "%PDF-";

    if (isPdf) {
      const text = await extractPdfText(buffer);
      if (!isReadable(text) || text.trim().length < 40) return null;
      return { title: firstLineTitle(text) || companyFromHost(url), company: companyFromHost(url), description: text.slice(0, 8000) };
    }

    const extracted = await extractJobFromHtml(buffer.toString("utf8"), url);
    if (!extracted || !isReadable(extracted.description) || extracted.description.length < 40) return null;
    return extracted;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function linkedInJobId(url: string): string | null {
  if (!/linkedin\.com/i.test(url)) return null;
  const match =
    url.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) ||
    url.match(/[?&]currentJobId=(\d{6,})/) ||
    url.match(/\/jobs\/view\/(\d{6,})/);
  return match ? match[1] : null;
}

async function fetchLinkedInJob(jobId: string, timeoutMs = 12000): Promise<ExtractedJob | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const pick = (regex: RegExp) => {
      const match = html.match(regex);
      return match ? normalize(decode(htmlToText(match[1]))) : "";
    };
    const title = pick(/<h2[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || pick(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const company = pick(/<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || pick(/<span[^>]*class="[^"]*topcard__flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const descMatch =
      html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      html.match(/class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? normalize(decode(htmlToText(descMatch[1]))) : "";
    if (!description || description.length < 60) return null;
    return { title: title || "LinkedIn job", company: company || "Unknown company", description: description.slice(0, 8000) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const result = await pdfParse(buffer);
    return normalize(result.text || "");
  } catch {
    return "";
  }
}

// Plain-text extraction from an uploaded job-description file (PDF / Word / text).
export async function extractTextFromFile(buffer: Buffer, name: string, type: string): Promise<string> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || type.includes("pdf") || buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return extractPdfText(buffer);
  }
  if (lower.endsWith(".docx") || type.includes("wordprocessingml")) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return normalize(result.value || "");
    } catch {
      return "";
    }
  }
  if (/\.(txt|md|rtf)$/.test(lower) || type.startsWith("text/")) {
    return normalize(buffer.toString("utf8"));
  }
  return "";
}

// Read a job posting from an image (screenshot) using a vision-capable model.
export async function extractJobFromImage(imageBase64: string, mimeType: string, model: string): Promise<ExtractedJob | null> {
  try {
    // Codex CLI takes images as file attachments rather than data URLs.
    if (isCodexModel(model)) {
      const ext = (mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
      const imagePath = path.join(os.tmpdir(), `job-shot-${Date.now()}.${ext}`);
      await writeFile(imagePath, Buffer.from(imageBase64, "base64"));
      try {
        const text = await runCodex(
          [
            {
              role: "system",
              content:
                'You read a job posting from an image (often a screenshot). Return ONLY a JSON object: {"title": string, "company": string, "description": string}. ' +
                "description = all readable job text (role summary, responsibilities, requirements, etc.). Transcribe faithfully; omit anything unreadable."
            },
            { role: "user", content: "Extract the job title, company, and full description from the attached image." }
          ],
          { responseFormat: "json", imagePaths: [imagePath] }
        );
        const parsedCodex = extractLooseJson<{ title?: string; company?: string; description?: string }>(text);
        if (!parsedCodex || !parsedCodex.description || String(parsedCodex.description).trim().length < 20) return null;
        return {
          title: String(parsedCodex.title || "").trim(),
          company: String(parsedCodex.company || "").trim(),
          description: String(parsedCodex.description).slice(0, 8000)
        };
      } finally {
        await rm(imagePath, { force: true }).catch(() => {});
      }
    }

    const client = await createLlmClient();
    const dataUrl = `data:${mimeType || "image/png"};base64,${imageBase64}`;
    const response = await client.chat.completions.create({
      model,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content:
            'You read a job posting from an image (often a screenshot). Return ONLY a JSON object: {"title": string, "company": string, "description": string}. ' +
            "description = all readable job text (role summary, responsibilities, requirements, etc.). Transcribe faithfully; omit anything unreadable."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the job title, company, and full description from this image." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    } as Parameters<typeof client.chat.completions.create>[0]);

    const text = (response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "";
    const parsed = extractLooseJson<{ title?: string; company?: string; description?: string }>(text);
    if (!parsed || !parsed.description || String(parsed.description).trim().length < 20) return null;
    return {
      title: String(parsed.title || "").trim(),
      company: String(parsed.company || "").trim(),
      description: String(parsed.description).slice(0, 8000)
    };
  } catch {
    return null;
  }
}

export async function extractJobFromHtml(html: string, url: string): Promise<ExtractedJob | null> {
  // Prefer schema.org JobPosting structured data (clean title/company/description).
  const structured = jsonLdJob(html);
  const metaTitle = decode((metaTag(html, "og:title") || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());
  const metaCompany = decode((metaTag(html, "og:site_name") || "").trim());

  if (structured) {
    return {
      title: structured.title || metaTitle || companyFromHost(url),
      company: structured.company || metaCompany || companyFromHost(url),
      description: structured.description
    };
  }

  // No structured data: strip page chrome (scripts, nav, icons, hidden elements),
  // focus on the main content region, then tidy the resulting text.
  const region = pickMainRegion(stripNonContent(html));
  const text = cleanExtractedText(decode(htmlToText(region)));
  const fallback: ExtractedJob = {
    title: metaTitle,
    company: metaCompany || companyFromHost(url),
    description: text.slice(0, 8000)
  };
  if (looksLikeJobDescription(text)) return fallback;

  // Still doesn't read like a posting (SPA shells, listing hubs, icon soup):
  // let a cheap model pull the real posting out of the cleaned text.
  const fromLlm = await extractJobWithLlm(text);
  if (fromLlm) {
    return {
      title: fromLlm.title || fallback.title,
      company: fromLlm.company || fallback.company,
      location: fromLlm.location,
      description: fromLlm.description
    };
  }
  return fallback;
}

// Remove markup that never contains posting content. Scripts are the critical one:
// e.g. Google careers pages embed dozens of OTHER jobs inside AF_initDataCallback
// blobs, which must not leak into the extracted description.
function stripNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    // aria-hidden elements are decorative (icon ligatures like "work_outline").
    // Matching open→first same-name close is safe for the flat elements icons use.
    .replace(/<([a-z][a-z0-9]*)\b[^>]*\baria-hidden\s*=\s*["']?true["']?[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

// Prefer the page's main content region when one is identifiable.
function pickMainRegion(html: string): string {
  const candidates = [
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    html.match(/<([a-z][a-z0-9]*)\b[^>]*\brole=["']main["'][^>]*>([\s\S]*)<\/\1>/i)?.[2],
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.replace(/<[^>]+>/g, " ").trim().length > 200) return candidate;
  }
  return html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
}

// Leftover single-word icon ligature names (Material icons render as text once
// the font is gone): "work_outline", "chevron_right", plus a few common bare ones.
const ICON_WORDS = new Set(["menu", "close", "search", "share", "launch", "done", "info", "bookmark", "home", "expand", "add", "remove"]);

function isIconJunkLine(line: string): boolean {
  if (line.length > 40) return false;
  const tokens = line.split(" ");
  if (tokens.length > 4) return false;
  return tokens.every((token) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token) || ICON_WORDS.has(token.toLowerCase()));
}

// Tidy text extracted from arbitrary pages: collapse repeated words/lines
// ("home home / Home Home" nav symptoms), drop icon junk, normalize whitespace.
function cleanExtractedText(raw: string): string {
  const out: string[] = [];
  let prev = "";
  for (const rawLine of raw.split("\n")) {
    // Collapse immediate word repeats within a line ("home home" -> "home").
    const line = rawLine.replace(/\s+/g, " ").trim().replace(/\b(\S{2,})(?: \1\b)+/g, "$1");
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (isIconJunkLine(line)) continue;
    if (line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Heuristic: does the cleaned text plausibly contain an actual job description?
function looksLikeJobDescription(text: string): boolean {
  if (text.length < 400) return false;
  if (!isReadable(text)) return false;
  return /\b(qualifications|responsibilities|requirements|experience|about the|what you.?ll do|who you are)\b/i.test(text);
}

// Last resort for pages where DOM cleanup still leaves noise: have a cheap model
// pull the posting out of the cleaned text. Extraction only — the model must not
// invent content, and returns null when the text holds no job posting.
async function extractJobWithLlm(text: string): Promise<ExtractedJob | null> {
  const input = text.trim().slice(0, 12000);
  if (input.length < 80) return null;
  try {
    const settings = await readSettings();
    const response = await runLlm({
      model: settings.searchModel || "google/gemini-2.5-flash-lite",
      maxTokens: 4000,
      messages: [
        {
          role: "system",
          content:
            'You extract a job posting from noisy text scraped from a web page. Return ONLY JSON: {"title": string, "company": string, "location": string, "description": string} or null. ' +
            "Use text from the input verbatim (or faithfully condensed) — never invent or embellish details that are not in the input. " +
            "description = the posting's real content (role summary, qualifications, responsibilities, benefits), excluding navigation/UI junk. " +
            "Use an empty string for fields the text does not state. If the input contains no job posting, return null."
        },
        { role: "user", content: input }
      ]
    });
    const parsed = extractLooseJson<{ title?: string; company?: string; location?: string; description?: string } | null>(response);
    if (!parsed || typeof parsed !== "object" || !parsed.description || String(parsed.description).trim().length < 80) return null;
    return {
      title: String(parsed.title || "").trim(),
      company: String(parsed.company || "").trim(),
      location: String(parsed.location || "").trim() || undefined,
      description: String(parsed.description).trim().slice(0, 8000)
    };
  } catch {
    return null;
  }
}

function jsonLdJob(html: string): ExtractedJob | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1].trim()) as Record<string, unknown>;
      const items: Record<string, unknown>[] = Array.isArray(data)
        ? (data as unknown as Record<string, unknown>[])
        : Array.isArray((data as { "@graph"?: unknown })["@graph"])
          ? ((data as { "@graph": Record<string, unknown>[] })["@graph"])
          : [data];
      for (const item of items) {
        const type = item?.["@type"];
        const isJob = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (!isJob) continue;
        const description = normalize(decode(htmlToText(String(item.description ?? ""))));
        if (description.length < 60) continue;
        const org = item.hiringOrganization as { name?: string } | string | undefined;
        const company = typeof org === "string" ? org : (org?.name ?? "");
        return {
          title: String(item.title ?? "").trim(),
          company: String(company).trim(),
          description: description.slice(0, 8000)
        };
      }
    } catch {
      // not valid JSON-LD — skip
    }
  }
  return null;
}

function metaTag(html: string, prop: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"))?.[1]
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|br|h[1-6]|tr|ul|ol|section|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function normalize(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const TWO_PART_TLDS = ["co.at", "or.at", "ac.at", "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "co.jp", "com.br", "co.in"];
const GENERIC_LABELS = new Set(["www", "jobs", "job", "careers", "career", "apply", "boards", "job-boards", "recruiting", "talent", "cdn"]);

export function companyFromHost(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com/.test(host) && segments[0]) {
      return prettifySlug(segments[0]);
    }
    return prettifySlug(mainDomainLabel(host));
  } catch {
    return "Unknown company";
  }
}

function mainDomainLabel(host: string): string {
  for (const tld of TWO_PART_TLDS) {
    if (host === tld || host.endsWith(`.${tld}`)) {
      const labels = host.slice(0, host.length - tld.length - 1).split(".").filter((label) => !GENERIC_LABELS.has(label));
      return labels[labels.length - 1] || host;
    }
  }
  const parts = host.split(".");
  if (parts.length <= 1) return host;
  const meaningful = parts.slice(0, -1).filter((label) => !GENERIC_LABELS.has(label));
  return meaningful[meaningful.length - 1] || parts[parts.length - 2];
}

function prettifySlug(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Unknown company";
  return cleaned.length <= 4 ? cleaned.toUpperCase() : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function firstLineTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) || "";
  return firstLine.split(/\.\s/)[0].replace(/\s+/g, " ").slice(0, 100).trim();
}

function isReadable(text: string): boolean {
  const sample = text.slice(0, 1200);
  if (!sample.trim()) return false;
  const weird = (sample.match(/[�\x00-\x08\x0E-\x1F]/g) || []).length;
  return weird / sample.length < 0.05;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}
