import { execFile, type ExecFileException } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmMessage } from "./llm.js";

// Routes LLM calls through the local Codex CLI so users on a ChatGPT plan can
// reuse that subscription instead of paying OpenRouter per token. The CLI
// handles auth itself (`codex login`); we never see or store credentials.

export const CODEX_MODEL_ID = "codex";

export function isCodexModel(model: string) {
  return model === CODEX_MODEL_ID || model.startsWith("codex/");
}

async function codexBinary(): Promise<string> {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return "codex"; // hope it's on PATH
}

let availabilityCache: { at: number; value: { available: boolean; reason?: string } } | null = null;

export async function codexAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (availabilityCache && Date.now() - availabilityCache.at < 60_000) return availabilityCache.value;

  let value: { available: boolean; reason?: string };
  const binary = await codexBinary();
  const installed = await new Promise<boolean>((resolve) => {
    execFile(binary, ["--version"], { timeout: 8000 }, (error) => resolve(!error));
  });
  if (!installed) {
    value = { available: false, reason: "Codex CLI not found — install it and run `codex login` (or set CODEX_PATH)." };
  } else {
    try {
      await access(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"));
      value = { available: true };
    } catch {
      value = { available: false, reason: "Codex CLI is installed but not logged in — run `codex login`." };
    }
  }

  availabilityCache = { at: Date.now(), value };
  return value;
}

function buildPrompt(messages: LlmMessage[], responseFormat?: "text" | "json") {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content);
  const rest = messages.filter((message) => message.role !== "system");
  const parts = [
    "You are being used as a plain text-generation backend by a local job-application app. " +
      "Do NOT run shell commands, do NOT read or write files, do NOT explore the workspace. " +
      "Reply with the final answer only — no preamble, no commentary about what you did."
  ];
  if (system.length) parts.push("## Instructions\n" + system.join("\n\n"));
  for (const message of rest) {
    parts.push(message.role === "assistant" ? "## Previous assistant reply\n" + message.content : "## Task\n" + message.content);
  }
  if (responseFormat === "json") parts.push("Respond with a single valid JSON object and nothing else.");
  return parts.join("\n\n");
}

export async function runCodex(
  messages: LlmMessage[],
  options?: { responseFormat?: "text" | "json"; imagePaths?: string[]; timeoutMs?: number }
): Promise<string> {
  const availability = await codexAvailability();
  if (!availability.available) throw new Error(availability.reason || "Codex CLI is not available.");

  const binary = await codexBinary();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "codex-llm-"));
  const outFile = path.join(workDir, "last-message.txt");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--ephemeral",
    "--color",
    "never",
    "-C",
    workDir,
    "-o",
    outFile
  ];
  for (const image of options?.imagePaths || []) args.push("-i", image);
  args.push("-"); // read the prompt from stdin (avoids ARG_MAX limits on long CVs)

  const prompt = buildPrompt(messages, options?.responseFormat);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { timeout: options?.timeoutMs ?? 300_000, maxBuffer: 32 * 1024 * 1024 },
        (error: ExecFileException | null, _stdout: string | Buffer, stderr: string | Buffer) => {
          if (!error) return resolve();
          const detail = (String(stderr || "") || error.message || "").slice(0, 400);
          if (/login|auth|unauthorized|401/i.test(detail)) {
            return reject(new Error("Codex CLI rejected the request — run `codex login` and try again."));
          }
          if (error.killed) {
            return reject(new Error("Codex took too long to answer. Try again or pick an OpenRouter model."));
          }
          reject(new Error(`Codex CLI failed: ${detail || "unknown error"}`));
        }
      );
      child.stdin?.end(prompt);
    });

    const text = (await readFile(outFile, "utf8").catch(() => "")).trim();
    if (!text) throw new Error("Codex returned an empty answer. Try again or pick an OpenRouter model.");
    return text;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
