import { readFileSync } from "node:fs";
import path from "node:path";
import { runLlm } from "./llm.js";
import { extractLooseJson } from "../utils/llmJson.js";

// The CV quality reference lives in server/config/cv-guide.md so it can be
// re-researched and edited without touching code. Read fresh on every use.

const GUIDE_PATH = path.resolve(process.cwd(), "server", "config", "cv-guide.md");

export type CvTrack = "engineering" | "diplomatic" | "general";

function readGuide(): string {
  try {
    return readFileSync(GUIDE_PATH, "utf8");
  } catch {
    return "";
  }
}

function section(guide: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*$`, "im");
  const match = pattern.exec(guide);
  if (!match) return "";
  const rest = guide.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

// Decide which kind of CV this vacancy needs. Deterministic keywords — cheap,
// predictable, and easy to extend. Title outweighs description.
export function detectTrack(jobTitle: string, jobDescription: string): CvTrack {
  const DIPLOMATIC = /diplomat|embassy|consul|foreign (?:service|affairs|ministry)|aussenministerium|international organi[sz]ation|united nations|\bUN\b|\bUNIDO\b|\bIAEA\b|\bOSCE\b|\bNGO\b|european (?:commission|council|parliament|union)|\bEU\b (?:policy|affairs|institution)|policy (?:officer|advisor|analyst)|governance|humanitarian|attach[eé]/i;
  const ENGINEERING = /engineer|developer|software|automation|devops|qa\b|test|backend|frontend|full[- ]?stack|cloud|data (?:scientist|engineer|analyst)|machine learning|\bAI\b|\bIT\b|sre\b|architect|programmier/i;
  if (DIPLOMATIC.test(jobTitle)) return "diplomatic";
  if (ENGINEERING.test(jobTitle)) return "engineering";
  if (DIPLOMATIC.test(jobDescription)) return "diplomatic";
  if (ENGINEERING.test(jobDescription)) return "engineering";
  return "general";
}

// Generation-time design rules for the detected track.
export function guidanceFor(track: CvTrack): string {
  const guide = readGuide();
  if (!guide) return "";
  const universal = section(guide, "UNIVERSAL");
  const trackBlock = section(guide, `TRACK: ${track}`) || section(guide, "TRACK: general");
  return `CV DESIGN RULES (profession track: ${track}) — follow strictly, they define what a perfect CV looks like for this application:\n${universal}\n\n${trackBlock}`;
}

export type CvEvaluation = { score: number; pass: boolean; issues: string[] };

// Final rubric-based evaluation by the reviewer model. Returns null when no
// evaluation is possible (no model / guide missing / tiny text).
export async function evaluateCv(
  model: string,
  track: CvTrack,
  cvText: string,
  job: { title: string; company: string; description: string }
): Promise<CvEvaluation | null> {
  const guide = readGuide();
  if (!model || !guide || cvText.trim().length < 200) return null;
  const rubric = [section(guide, "UNIVERSAL"), section(guide, `TRACK: ${track}`), section(guide, "FINAL CHECKLIST")]
    .filter(Boolean)
    .join("\n\n");
  try {
    const response = await runLlm({
      model,
      responseFormat: "json",
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "You are a strict CV quality evaluator. Score the CV against the rubric for THIS vacancy. " +
            'Return ONLY JSON: {"score": 1-10, "pass": boolean, "issues": string[]}. ' +
            "pass=true only when score >= 8. issues = the most important concrete weaknesses (max 6), each phrased as an actionable fix. " +
            "Judge only what is in the CV text — do not demand information you cannot know is available, and never suggest inventing anything."
        },
        {
          role: "user",
          content: `RUBRIC (track: ${track}):\n${rubric}\n\nVACANCY: ${job.title} at ${job.company}\n${job.description.slice(0, 2500)}\n\nCV TEXT:\n${cvText.slice(0, 9000)}`
        }
      ]
    });
    const parsed = extractLooseJson<{ score?: number; pass?: boolean; issues?: string[] }>(response);
    if (!parsed || typeof parsed.score !== "number") return null;
    const score = Math.max(1, Math.min(10, Math.round(parsed.score)));
    return {
      score,
      pass: parsed.pass === true || score >= 8,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((issue) => typeof issue === "string").slice(0, 6) : []
    };
  } catch {
    return null;
  }
}
