import { getSecret } from "./secrets.js";

export interface TavilyResult {
  title: string;
  url: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilyResult[];
  response_time?: string;
  usage?: { credits?: number };
}

export async function searchTavily(input: { role: string; city: string; maxResults: number }) {
  const apiKey = await getSecret("api.tavily.com", process.env.TAVILY_API_KEY);
  if (!apiKey) {
    throw new Error("Missing Tavily API key. Add it in Settings before searching jobs.");
  }

  const query = [
    input.role,
    "jobs",
    input.city,
    "apply",
    "company careers",
    "Greenhouse OR Lever OR Workday"
  ].join(" ");

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: Math.min(Math.max(input.maxResults, 1), 20),
      include_answer: false,
      include_raw_content: "text",
      include_favicon: true
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as TavilySearchResponse;
}
