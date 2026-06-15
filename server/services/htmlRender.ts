import { mkdir } from "node:fs/promises";
import path from "node:path";

// Render an HTML string to a PDF using the Playwright Chromium that is already
// installed for the apply worker. Returns null if Playwright is unavailable.

type PdfOptions = {
  path: string;
  format: "A4";
  printBackground: boolean;
  margin: { top: string; bottom: string; left: string; right: string };
};

type Page = {
  setContent(html: string, options: { waitUntil: "load" | "networkidle" }): Promise<unknown>;
  pdf(options: PdfOptions): Promise<Buffer>;
};

type Browser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

type BrowserModule = {
  chromium: { launch(options: { headless: boolean }): Promise<Browser> };
};

async function loadPlaywright(): Promise<BrowserModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<BrowserModule>;
    return await dynamicImport("playwright");
  } catch {
    return null;
  }
}

export async function renderHtmlToPdf(html: string, outPath: string): Promise<string | null> {
  const playwright = await loadPlaywright();
  if (!playwright) return null;

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await mkdir(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" }
    });
    return outPath;
  } finally {
    await browser.close();
  }
}
