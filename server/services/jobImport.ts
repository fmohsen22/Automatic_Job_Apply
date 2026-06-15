import pdfParse from "pdf-parse/lib/pdf-parse.js";

// Fetch a job posting the user found and extract title / company / description so
// they can tailor their CV to it. Handles HTML pages (incl. schema.org JobPosting
// structured data), PDF postings, and LinkedIn (via its public guest endpoint —
// public data only, no login). Applying still stays manual on LinkedIn.

export type ExtractedJob = { title: string; company: string; description: string };

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

    const extracted = extractJobFromHtml(buffer.toString("utf8"), url);
    if (!isReadable(extracted.description) || extracted.description.length < 40) return null;
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

function extractJobFromHtml(html: string, url: string): ExtractedJob {
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

  const body = htmlToText(html);
  return {
    title: metaTitle,
    company: metaCompany || companyFromHost(url),
    description: normalize(decode(body)).slice(0, 8000)
  };
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
    .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, "\n")
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
