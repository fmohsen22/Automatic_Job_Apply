import { runLlm } from "./llm.js";
import { extractLooseJson } from "../utils/llmJson.js";

export type SearchIntent = { roles: string[]; location: string; keywords: string[] };

// Turn a free-text paragraph ("I studied petroleum engineering and also work as a
// software developer, want roles in Vienna…") into concrete job-search terms:
// the roles to search for, a location, and key skills. Falls back to the raw text
// if the model is unavailable so search still runs.
export async function extractSearchIntent(paragraph: string, locationHint: string, model: string): Promise<SearchIntent> {
  const fallback: SearchIntent = {
    roles: [paragraph.trim().replace(/\s+/g, " ").slice(0, 80)].filter(Boolean),
    location: locationHint.trim(),
    keywords: []
  };

  // Try the configured model, then a reliable cheap default, before giving up.
  const models = [model, "google/gemini-2.5-flash-lite"].filter((value, index, all) => value && all.indexOf(value) === index);

  for (const candidate of models) {
    try {
      const response = await runLlm({
        model: candidate,
        responseFormat: "json",
        maxTokens: 500,
        messages: [
          {
            role: "system",
            content:
              "You convert a job seeker's free-text description into search terms. Return ONLY a JSON object: " +
              '{"roles": string[], "location": string, "keywords": string[]}. ' +
              "roles = 1-5 concise job titles to search for, exactly as someone would type them into a job board (e.g. \"software developer\", \"petroleum engineer\", \"backend engineer\"). " +
              "location = the city / region / country they want, or \"\" if none. " +
              "keywords = up to 8 important skills, tools, or preferences (e.g. \"Python\", \"remote\", \"AI\"). Keep everything short, no sentences."
          },
          { role: "user", content: `Description: ${paragraph}\nLocation hint: ${locationHint || "(none)"}` }
        ]
      });

      const parsed = extractLooseJson<Partial<SearchIntent>>(response);
      if (!parsed) continue;

      const roles = Array.isArray(parsed.roles)
        ? parsed.roles.filter((role): role is string => typeof role === "string" && role.trim().length > 0).map((role) => role.trim()).slice(0, 5)
        : [];
      if (!roles.length) continue;

      const keywords = Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0).map((kw) => kw.trim()).slice(0, 8)
        : [];
      const location = typeof parsed.location === "string" && parsed.location.trim() ? parsed.location.trim() : locationHint.trim();

      return { roles, location, keywords };
    } catch {
      // try the next model
    }
  }

  return fallback;
}
