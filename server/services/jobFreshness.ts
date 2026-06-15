// Detects expired/closed job postings so they are not shown. Conservative: only
// treats a posting as expired on a 404/410 or an explicit "no longer accepting"
// message. Network errors / blocked (403, 5xx) are treated as "unknown — keep",
// so a flaky fetch never hides a good job.

export type FreshnessResult = { live: boolean; reason?: string };

const EXPIRY_PHRASES = [
  "no longer accepting applications",
  "no longer accepting application",
  "we are no longer accepting",
  "are no longer accepting candidates",
  "job is no longer available",
  "position is no longer available",
  "posting is no longer available",
  "this job is no longer",
  "this position is no longer",
  "this role is no longer",
  "opportunity is no longer available",
  "position has been filled",
  "role has been filled",
  "posting has expired",
  "job has expired",
  "this posting has expired",
  "posting is no longer active",
  "applications are closed",
  "application period has closed",
  "this position is closed",
  "this job is closed",
  "vacancy is closed",
  "the job you are looking for is no longer",
  "job not found",
  "job posting not found",
  "this job has been closed",
  "position is closed"
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function checkJobLive(url: string, timeoutMs = 8000): Promise<FreshnessResult> {
  if (!/^https?:\/\//i.test(url)) return { live: true, reason: "unverified (not http)" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" }
    });

    if (response.status === 404 || response.status === 410) {
      return { live: false, reason: `gone (HTTP ${response.status})` };
    }
    if (!response.ok) {
      // 403/429/5xx etc. — site blocked us or had a hiccup; don't judge it expired.
      return { live: true, reason: `unverified (HTTP ${response.status})` };
    }

    const text = (await response.text()).slice(0, 120000).toLowerCase();
    const hit = EXPIRY_PHRASES.find((phrase) => text.includes(phrase));
    if (hit) return { live: false, reason: `"${hit}"` };
    return { live: true };
  } catch {
    return { live: true, reason: "unverified (fetch error)" };
  } finally {
    clearTimeout(timer);
  }
}

// Run an async mapper over items with a bounded concurrency.
export async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
