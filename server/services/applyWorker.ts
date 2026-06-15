import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { audit } from "./audit.js";
import { type AutonomyLevel, policyForUrl } from "./domainPolicies.js";
import { fromJsonString, toJsonString } from "../utils/json.js";

// Headed browsers that were handed off to the user stay open so they can finish
// (solve CAPTCHA, click Submit). We keep references so they are not garbage-collected.
const openBrowsers = new Set<Browser>();

type ApplyInput = {
  autonomyLevel: AutonomyLevel;
  dryRun?: boolean;
};

type ApplyStep = {
  label: string;
  status: "ok" | "blocked" | "warning";
  detail: string;
};

type BrowserModule = {
  chromium: {
    launch(options: { headless: boolean }): Promise<Browser>;
  };
};

type Browser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

type Page = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  title(): Promise<string>;
  textContent(selector: string): Promise<string | null>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  getByRole(role: string, options: { name: RegExp }): { first(): Locator };
  getByText(text: RegExp): { first(): Locator };
};

type Locator = {
  count(): Promise<number>;
  click(options: { timeout: number }): Promise<unknown>;
};

export async function runApplyWorker(jobId: string, input: ApplyInput) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      docSets: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { cvVersion: true }
      }
    }
  });

  if (!job) {
    throw new Error("Job not found.");
  }

  const policy = policyForUrl(job.url);
  const steps: ApplyStep[] = [
    {
      label: "Policy check",
      status: policy.mode === "manual-only" ? "blocked" : "ok",
      detail: `${policy.domain} is ${policy.mode}. ${policy.warning ?? ""}`.trim()
    }
  ];
  const screenshots: string[] = [];
  const run = await prisma.applicationRun.create({
    data: {
      jobId: job.id,
      autonomyLevel: input.autonomyLevel,
      status: "RUNNING",
      steps: toJsonString(steps),
      screenshots: toJsonString(screenshots)
    }
  });

  try {
    if (!job.docSets.length) {
      return await finishRun(run.id, "NEEDS_PREPARATION", screenshots, [
        ...steps,
        {
          label: "Preparation required",
          status: "blocked",
          detail: "Prepare and approve a tailored CV/cover letter before applying."
        }
      ]);
    }

    if (policy.mode === "manual-only") {
      return await finishRun(run.id, "BLOCKED_POLICY", screenshots, steps);
    }

    if (input.autonomyLevel === "L0") {
      return await finishRun(run.id, "ASSIST_ONLY", screenshots, [
        ...steps,
        {
          label: "Autonomy level",
          status: "blocked",
          detail: "L0 Assist mode prepares guidance only and does not drive the browser."
        }
      ]);
    }

    if (policy.mode === "assisted-only" && input.autonomyLevel === "L2") {
      steps.push({
        label: "Autonomy downgrade",
        status: "warning",
        detail: "This domain is assisted-only, so the worker will stop before account creation, CAPTCHA, or final submit."
      });
    }

    const playwright = await loadPlaywright();
    if (!playwright) {
      return await finishRun(run.id, "BLOCKED_PLAYWRIGHT_MISSING", screenshots, [
        ...steps,
        {
          label: "Browser automation unavailable",
          status: "blocked",
          detail: "Playwright is not installed. Run npm install playwright and npx playwright install chromium before browser apply."
        }
      ]);
    }

    const docSet = job.docSets[0];
    const browser = await playwright.chromium.launch({ headless: Boolean(input.dryRun) });
    let leaveOpen = false;
    try {
      const page = await browser.newPage();
      await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      screenshots.push(await screenshot(page, run.id, "posting"));
      const title = await page.title();
      const bodyText = (await page.textContent("body")) ?? "";
      steps.push({ label: "Opened posting", status: "ok", detail: title || job.url });

      const blocker = detectBlocker(bodyText);
      if (input.dryRun) {
        if (blocker) {
          return await finishRun(run.id, blocker.status, screenshots, [
            ...steps,
            { label: blocker.label, status: "blocked", detail: blocker.detail }
          ]);
        }
        return await finishRun(run.id, "DRY_RUN_READY", screenshots, [
          ...steps,
          { label: "Dry run complete", status: "ok", detail: "The posting opens without an obvious CAPTCHA/account blocker. Nothing was filled or submitted." }
        ]);
      }

      // Assisted mode: a CAPTCHA/login is not a hard stop — note it and let the
      // user resolve it in the handed-off browser window. We never solve it for them.
      if (blocker) {
        steps.push({ label: blocker.label, status: "warning", detail: `${blocker.detail} You'll resolve this yourself in the open browser window.` });
      }

      // Assisted apply: open the application, auto-fill what we can, attach the CV,
      // then HAND OFF — leave the visible browser open for the user to solve any
      // CAPTCHA and click Submit themselves. We never bypass anti-bot controls.
      const clickedApply = await clickApply(page);
      await safeWait(page, 1800);
      screenshots.push(await screenshot(page, run.id, "after-apply-click"));

      const profile = parseProfile(fromJsonString<Record<string, unknown>>(docSet.cvVersion?.json, {}));
      const cvPath = pickCvFile(docSet);
      const filled = await assistFillForm(page, profile, cvPath, steps);
      screenshots.push(await screenshot(page, run.id, "after-fill"));

      leaveOpen = true;
      openBrowsers.add(browser);
      return await finishRun(run.id, "READY_FOR_REVIEW", screenshots, [
        ...steps,
        {
          label: "Handed off for review",
          status: "ok",
          detail: filled > 0
            ? "Your application was pre-filled in the open browser window. Review it, solve any CAPTCHA, and click Submit there — then close the window."
            : "The application is open in the browser window. No standard fields were detected to auto-fill — complete it there, solve any CAPTCHA, and click Submit."
        }
      ]);
    } finally {
      if (!leaveOpen) await browser.close();
    }
  } catch (error) {
    return await finishRun(run.id, "FAILED", screenshots, [
      ...steps,
      {
        label: "Worker error",
        status: "blocked",
        detail: error instanceof Error ? error.message : "Unknown apply worker error"
      }
    ]);
  }
}

export function presentApplicationRun<T extends { steps: string; screenshots: string }>(run: T) {
  return {
    ...run,
    steps: fromJsonString<ApplyStep[]>(run.steps, []),
    screenshots: fromJsonString<string[]>(run.screenshots, [])
  };
}

async function finishRun(id: string, status: string, screenshots: string[], steps: ApplyStep[]) {
  const run = await prisma.applicationRun.update({
    where: { id },
    data: {
      status,
      steps: toJsonString(steps),
      screenshots: toJsonString(screenshots)
    }
  });

  await audit("application.run.finished", `Application worker finished with ${status}`, {
    entity: "ApplicationRun",
    entityId: run.id,
    metadata: {
      jobId: run.jobId,
      status,
      screenshots
    }
  });

  return presentApplicationRun(run);
}

async function loadPlaywright(): Promise<BrowserModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<BrowserModule>;
    return await dynamicImport("playwright");
  } catch {
    return null;
  }
}

async function screenshot(page: Page, runId: string, name: string) {
  const dir = path.resolve(process.cwd(), "storage", "screenshots");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${runId}-${name}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function detectBlocker(text: string) {
  if (/captcha|verify you are human|security check|unusual traffic/i.test(text)) {
    return {
      status: "BLOCKED_CAPTCHA",
      label: "CAPTCHA or anti-bot check",
      detail: "The page appears to require human verification, so automation stopped."
    };
  }
  if (/create account|sign up|register|login|log in|sign in/i.test(text)) {
    return {
      status: "BLOCKED_ACCOUNT",
      label: "Account or login required",
      detail: "The page appears to require an account/login step, so automation stopped for user permission."
    };
  }
  return null;
}

async function clickApply(page: Page) {
  const candidates = [
    page.getByRole("link", { name: /apply|bewerben/i }).first(),
    page.getByRole("button", { name: /apply|bewerben/i }).first(),
    page.getByText(/apply now|apply for this job|bewerben/i).first()
  ];

  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) > 0) {
        await candidate.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

async function safeWait(page: Page, ms: number) {
  try {
    await (page as unknown as { waitForTimeout(ms: number): Promise<void> }).waitForTimeout(ms);
  } catch {
    // ignore
  }
}

function pickCvFile(docSet: { cvPdfPath?: string | null; cvDocxPath?: string | null }): string | null {
  for (const candidate of [docSet.cvPdfPath, docSet.cvDocxPath]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

type Profile = { fullName: string; firstName: string; lastName: string; email: string; phone: string };

function parseProfile(cv: Record<string, unknown>): Profile {
  const rawText = typeof cv.rawText === "string" ? cv.rawText : "";
  const name = typeof cv.name === "string" && cv.name.trim()
    ? cv.name.trim()
    : (rawText.split("\n").map((line) => line.trim()).find(Boolean) ?? "");
  const email = rawText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  const phone = rawText.match(/\+?\d[\d ()\-]{7,}\d/)?.[0] ?? "";
  const parts = name.split(/\s+/).filter(Boolean);
  return { fullName: name, firstName: parts[0] ?? "", lastName: parts.slice(1).join(" "), email, phone };
}

// Best-effort: fill common ATS contact fields and attach the CV. Never throws —
// anything it can't fill is left for the user to complete in the open browser.
async function assistFillForm(page: Page, profile: Profile, cvPath: string | null, steps: ApplyStep[]): Promise<number> {
  const scope = page as unknown as {
    locator(selector: string): { first(): { count(): Promise<number>; fill(value: string, options?: { timeout: number }): Promise<void>; setInputFiles(files: string, options?: { timeout: number }): Promise<void> } };
  };
  let filled = 0;

  const fillFirst = async (selectors: string[], value: string) => {
    if (!value) return;
    for (const selector of selectors) {
      try {
        const locator = scope.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.fill(value, { timeout: 3000 });
          filled += 1;
          return;
        }
      } catch {
        // try next selector
      }
    }
  };

  await fillFirst(["#first_name", "input[name='first_name']", "input[name='firstName']", "input[autocomplete='given-name']"], profile.firstName);
  await fillFirst(["#last_name", "input[name='last_name']", "input[name='lastName']", "input[autocomplete='family-name']"], profile.lastName);
  await fillFirst(["input[name='name']", "#full_name", "#name", "input[autocomplete='name']"], profile.fullName);
  await fillFirst(["#email", "input[type='email']", "input[name='email']", "input[autocomplete='email']"], profile.email);
  await fillFirst(["#phone", "input[type='tel']", "input[name='phone']", "input[autocomplete='tel']"], profile.phone);

  if (cvPath) {
    try {
      const fileInput = scope.locator("input[type='file']").first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(cvPath, { timeout: 5000 });
        filled += 1;
      }
    } catch {
      // file input not found / not settable
    }
  }

  steps.push({
    label: "Auto-fill",
    status: filled > 0 ? "ok" : "warning",
    detail: filled > 0 ? `Pre-filled ${filled} field(s)/attachment(s).` : "No standard fields found to pre-fill on this page."
  });
  return filled;
}
