# Automate JobApply

Local AI job-search and assisted-apply workspace. M1 is a runnable foundation: React dashboard, Express API, SQLite via Prisma, encrypted settings storage, base CV import/versioning, safety defaults, and audit log.

## Run M1

```bash
cp .env.example .env
npm install
npm run prisma:push
npm run dev
```

Open `http://127.0.0.1:5173`.

The API runs at `http://127.0.0.1:4100`; Vite proxies `/api` to it.

## Environment

- `OPENAI_API_KEY`: default LLM provider key for later milestones.
- `TAVILY_API_KEY`: job/web search provider key for M2.
- `GOOGLE_OAUTH_*`: optional email assist for M6.
- `ENCRYPTION_KEY`: used to encrypt stored credentials at rest.
- `DEFAULT_AUTONOMY_LEVEL`: `L0`, `L1`, or `L2`; default is `L1`.
- `DEFAULT_CITY`: optional default city for job profiles.
- `DEFAULT_MODEL`: configurable OpenAI model name.

Real `.env` files are ignored by git.

## Autonomy Levels

- `L0 Assist`: the app prepares documents and guidance; you click and submit.
- `L1 Semi-auto`: default. The worker can fill forms, but pauses before account creation and final submit.
- `L2 Full-auto`: opt-in. The worker may submit without pausing, with full audit logging.

CAPTCHA or anti-bot challenges always stop automation and hand control back to you.

## Safety Model

The app keeps a domain policy registry. High-risk sites such as LinkedIn are manual/assisted-only by default because automated submission can violate terms and risk account restrictions. The future apply worker should prefer official APIs, company ATS portals, human-paced delays, dry-run mode, and visible approval gates.

Secrets are encrypted at rest, never returned to the browser after saving, and not written to audit metadata.

## Milestones

- M1: Scaffold, dashboard shell, SQLite/Prisma, settings, base CV import.
- M2: Tavily/job-board search, dedupe, fit ranking.
- M3: Tailoring, review UI, approval gate, document rendering.
- M4: Playwright apply worker, ATS adapters, screenshots, dry-run.
- M5: `ui-test-pilot` dashboard scenarios from `../ui-test-pilot` via file dependency.
- M6: Optional Gmail read-only and draft-reply flow.
