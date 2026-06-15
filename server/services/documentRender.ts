import { spawn } from "node:child_process";
import { access, realpath, rename } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// We render the tailored .docx to PDF with LibreOffice headless. It is the only
// reliable, non-interactive docx->pdf path (Microsoft Word is sandboxed and
// cannot save to arbitrary app folders). If no working LibreOffice is found we
// return null and the caller keeps the .docx-only output.

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

let cachedBinary: string | null | undefined;

export async function findLibreOffice(): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;

  for (const candidate of CANDIDATE_BINARIES) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      cachedBinary = resolved;
      return resolved;
    }
  }

  cachedBinary = null;
  return null;
}

export async function convertDocxToPdf(docxPath: string, outDir: string): Promise<string | null> {
  const binary = await findLibreOffice();
  if (!binary) return null;

  // LibreOffice names the output after the input file. We convert, then rename
  // to the requested target so callers control the final filename.
  const ok = await runConvert(binary, docxPath, outDir);
  if (!ok) return null;

  const producedPdf = path.join(outDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
  try {
    await access(producedPdf, constants.F_OK);
    const targetPdf = path.join(outDir, "cv.pdf");
    if (producedPdf !== targetPdf) {
      await rename(producedPdf, targetPdf);
      return targetPdf;
    }
    return producedPdf;
  } catch {
    return null;
  }
}

async function resolveExecutable(candidate: string): Promise<string | null> {
  // For absolute paths, make sure the file (or the symlink target) actually
  // exists and is executable — the user's `soffice` is a dangling symlink.
  if (candidate.includes("/")) {
    try {
      const real = await realpath(candidate);
      await access(real, constants.X_OK);
      return real;
    } catch {
      return null;
    }
  }
  // Bare command names are left for the OS to resolve via PATH at spawn time;
  // we only trust them if a `which`-style lookup succeeds.
  return whichLookup(candidate);
}

function whichLookup(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/env", ["which", command]);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const found = out.trim().split("\n")[0]?.trim();
      resolve(code === 0 && found ? found : null);
    });
  });
}

function runConvert(binary: string, docxPath: string, outDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      docxPath
    ], { stdio: "ignore" });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 60000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
