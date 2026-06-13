# Automate JobApply

Local AI job-search and assisted-apply workspace. The app is designed to run on your own Mac or Windows computer, with local SQLite storage, encrypted settings, base CV import/versioning, Tavily job search, OpenRouter model routing, safety defaults, and audit log.

## One-Click Local Run

Prerequisite: install Node.js 20 LTS or newer from `https://nodejs.org`.

macOS:

1. Double-click `run-mac.command`.
2. If macOS blocks it the first time, right-click the file, choose Open, then approve.
3. The script creates `.env`, installs packages, syncs SQLite, starts the local server, and opens the app.

Windows:

1. Double-click `run-windows.bat`.
2. The script creates `.env`, installs packages, syncs SQLite, starts the local server, and opens the app.

The UI opens at `http://127.0.0.1:4173`. The API runs at `http://127.0.0.1:4100`.

## Manual Run

```bash
cp .env.example .env
npm install
npm run prisma:push
npm run dev
```

You can also run `npm run local`, which performs the same bootstrap used by the click launchers.

## First Setup In The UI

Open Settings and enter:

- OpenRouter API key: used for Claude, Gemini, Grok, DeepSeek, and other models through OpenRouter.
- Tavily API key: used for job/web search in M2.
- Search Model: recommended a fast/cheap model such as Grok Fast or Gemini Flash Lite.
- Tailor Model: recommended `anthropic/claude-sonnet-4.5`.
- Apply Model: recommended `anthropic/claude-sonnet-4.5`.
- General Model: recommended `anthropic/claude-sonnet-4.5`.

After saving an OpenRouter key, Settings loads the live OpenRouter model list into purpose-specific dropdowns. The app auto-suggests a fast model for search and Claude Sonnet for tailoring and apply tasks.

Keys are stored encrypted on the local computer and are not returned to the browser after saving.

## Environment

- `OPENROUTER_API_KEY`: OpenRouter key for Claude and other model providers.
- `TAVILY_API_KEY`: job/web search provider key for M2.
- `GOOGLE_OAUTH_*`: optional email assist for M6.
- `ENCRYPTION_KEY`: used to encrypt stored credentials at rest.
- `DEFAULT_AUTONOMY_LEVEL`: `L0`, `L1`, or `L2`; default is `L1`.
- `DEFAULT_CITY`: optional default city for job profiles.
- `SEARCH_MODEL`: model used for job fit ranking.
- `TAILOR_MODEL`: model used for CV and cover-letter tailoring.
- `APPLY_MODEL`: model used for application assistance.
- `GENERAL_MODEL`: model used for shared assistant tasks.

Real `.env` files are ignored by git.

## Job Search

Open `Job Search`, enter a role and city, then click `Search Jobs`.

The M2 flow:

1. Calls Tavily search with the saved Tavily API key.
2. Normalizes and dedupes results into local SQLite.
3. Reads the latest CV version.
4. Ranks each job with the configured OpenRouter search model.
5. Falls back to Tavily relevance if LLM ranking is unavailable.
6. Shows jobs sorted by fit score with reasons and posting links.

No API keys should be pasted into chat or committed to git. Enter them only in the local Settings UI.

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
- M2: Tavily search, dedupe, fit ranking, ranked job list UI, OpenRouter model dropdown.
- M3: Tailoring, review UI, approval gate, document rendering.
- M4: Playwright apply worker, ATS adapters, screenshots, dry-run.
- M5: `ui-test-pilot` dashboard scenarios from `../ui-test-pilot` via file dependency.
- M6: Optional Gmail read-only and draft-reply flow.

## Full Process Roadmap

1. Start the app locally with the Mac or Windows launcher.
2. Add API keys and choose model routing in Settings.
3. Import or paste the base CV into the CV Store.
4. Search for jobs by role, city, and filters.
5. Normalize and dedupe jobs from Tavily and future job-board providers.
6. Rank jobs against the latest CV with the configured search model.
7. Pick a job from the ranked list.
8. Generate a tailored CV, cover letter, and requirements checklist with the configured tailoring model.
9. Review differences, edit documents, request re-tailoring, or approve.
10. After approval, run the apply worker in L0/L1/L2 autonomy mode.
11. Pause before account creation, final submit, CAPTCHA, or risky domains by default.
12. Store application status, screenshots, and audit events locally.
13. Optionally connect email assist later for read-only summaries and draft replies.
