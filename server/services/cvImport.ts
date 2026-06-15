import crypto from "node:crypto";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type ImportableFile = {
  name: string;
  type: string;
  contentBase64: string;
};

export async function parseCvFile(file: ImportableFile) {
  const buffer = Buffer.from(file.contentBase64, "base64");
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".json") || file.type.includes("json")) {
    return normalizeText(buffer.toString("utf8"));
  }

  if (lower.endsWith(".docx") || file.type.includes("wordprocessingml")) {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeText(result.value);
  }

  if (lower.endsWith(".pdf") || file.type.includes("pdf")) {
    const result = await pdfParse(buffer);
    return normalizeText(result.text);
  }

  return normalizeText(buffer.toString("utf8"));
}

export function selectBestCvFile(files: ImportableFile[]) {
  return [...files].sort((left, right) => scoreFile(right) - scoreFile(left))[0];
}

export function hashContent(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeText(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return {
      rawText: text.trim(),
      basics: {},
      experience: [],
      education: [],
      skills: []
    };
  }
}

function scoreFile(file: ImportableFile) {
  const lower = file.name.toLowerCase();
  const textScore = lower.includes("resume") || lower.includes("cv") || lower.includes("curriculum") || lower.includes("vitae") ? 50 : 0;
  const extensionScore = lower.endsWith(".pdf") ? 30 : lower.endsWith(".docx") ? 25 : lower.endsWith(".json") ? 20 : 10;
  return textScore + extensionScore;
}
