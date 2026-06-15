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

export function buildJobSearchQueries(input: { roles: string[]; location?: string; keywords?: string[]; targetResults: number }) {
  const location = input.location?.trim();
  const roles = (input.roles.length ? input.roles : ["jobs"]).map((role) => role.trim().replace(/\s+/g, " ")).filter(Boolean);
  const kw = (input.keywords ?? []).slice(0, 3).join(" ").trim();
  const place = location ? ` in ${location}` : "";
  const placeBare = location ? ` ${location}` : "";

  const queries: string[] = [];
  for (const role of roles) {
    queries.push(`${role} jobs${place} apply now`);
    queries.push(`${role}${placeBare} careers hiring`);
    queries.push(`${role}${placeBare} site:greenhouse.io`);
    queries.push(`${role}${placeBare} site:lever.co`);
    queries.push(`${role}${placeBare} site:ashbyhq.com`);
    queries.push(`${role}${placeBare} site:smartrecruiters.com`);
    queries.push(`${role}${placeBare} site:workdayjobs.com`);
    queries.push(`${role} remote jobs${kw ? ` ${kw}` : ""}`);
    if (kw) queries.push(`${role} jobs${place} ${kw}`);
  }

  const volume = Math.min(Math.max(Math.ceil(input.targetResults / 20), 12), 80);
  return [...new Set(queries)].slice(0, volume);
}

export async function searchTavily(input: { roles: string[]; location?: string; keywords?: string[]; targetResults: number }) {
  const apiKey = await readTavilyApiKey();
  const queries = buildJobSearchQueries(input);
  const perQuery = 20;
  const batches = await Promise.allSettled(
    queries.map((query) => searchTavilyQuery({ apiKey, query, maxResults: perQuery }))
  );

  const results = batches.flatMap((batch) => (batch.status === "fulfilled" ? batch.value.results : []));
  const errors = batches.flatMap((batch, index) =>
    batch.status === "rejected" ? [`${queries[index]}: ${batch.reason instanceof Error ? batch.reason.message : "Search failed"}`] : []
  );

  if (!results.length && errors.length) {
    throw new Error(errors.join("; "));
  }

  return {
    query: queries.join(" | "),
    queries,
    results,
    errors
  };
}

async function readTavilyApiKey() {
  const apiKey = await getSecret("api.tavily.com", process.env.TAVILY_API_KEY);
  if (!apiKey) {
    throw new Error("Missing Tavily API key. Add it in Settings before searching jobs.");
  }
  return apiKey;
}

async function searchTavilyQuery(input: { apiKey: string; query: string; maxResults: number }) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: input.query,
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
