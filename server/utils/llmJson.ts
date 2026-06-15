// Best-effort JSON extraction from LLM output.
// Models (especially Claude via OpenRouter) often wrap JSON in ```json fences
// or add stray prose, so a plain JSON.parse is not reliable on its own.
export function extractLooseJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;

  const direct = tryParse(raw);
  if (direct !== null) return direct as T;

  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const fromUnfenced = tryParse(unfenced);
  if (fromUnfenced !== null) return fromUnfenced as T;

  const objSlice = sliceBetween(raw, "{", "}");
  if (objSlice) {
    const parsed = tryParse(objSlice);
    if (parsed !== null) return parsed as T;
  }

  const arrSlice = sliceBetween(raw, "[", "]");
  if (arrSlice) {
    const parsed = tryParse(arrSlice);
    if (parsed !== null) return parsed as T;
  }

  return null;
}

function sliceBetween(raw: string, open: string, close: string) {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1);
  }
  return null;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
