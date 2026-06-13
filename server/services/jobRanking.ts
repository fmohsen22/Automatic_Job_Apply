import { runLlm } from "./llm.js";

export interface RankingInput {
  cv: unknown;
  title: string;
  company: string;
  description: string;
  fallbackScore: number;
  model: string;
}

export async function rankJob(input: RankingInput) {
  try {
    const response = await runLlm({
      model: input.model,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content:
            "You rank job advertisements against a candidate CV. Return only JSON with score as an integer 0-100 and reasons as an array of 2-5 concise strings."
        },
        {
          role: "user",
          content: JSON.stringify({
            cv: input.cv,
            job: {
              title: input.title,
              company: input.company,
              description: input.description
            }
          })
        }
      ]
    });
    const parsed = JSON.parse(response) as { score?: number; reasons?: string[] };
    return {
      score: clampScore(parsed.score ?? input.fallbackScore),
      reasons: Array.isArray(parsed.reasons) && parsed.reasons.length ? parsed.reasons : ["Ranked by model."]
    };
  } catch (error) {
    return {
      score: clampScore(input.fallbackScore),
      reasons: [
        "Used Tavily relevance because LLM ranking was unavailable.",
        error instanceof Error ? error.message : "Unknown ranking error"
      ]
    };
  }
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
