# Automate JobApply

Automate JobApply is a local AI workspace for searching jobs, ranking them against your experience, preparing tailored application documents, and tracking assisted application attempts.

The app runs on your own computer. It stores data in local SQLite, encrypts saved API keys, keeps an audit log, and uses explicit safety stops for risky application flows.

## What It Does

- Import many CVs, resumes, certificates, profile notes, and experience documents.
- Select one CV as the active template for tailoring.
- Search jobs from a natural-language request such as:
  - `Software developer with petroleum engineering experience`
  - `AI automation roles in Vienna, remote or hybrid`
- Save every search run and its results in search history.
- Rank found jobs against your selected CV and uploaded background material.
- Open a job detail page and generate:
  - tailored CV draft
  - cover letter
  - requirements checklist
- Track application attempts with status, steps, and screenshots.
- Stop automation when a site requires manual handling, login/account creation, CAPTCHA, or final-submit review.

## Output formats

When you generate materials for a job you choose an **Output format / template**:

- **Navy / Energy** — an HTML-rendered design; your tailored content becomes a polished **PDF**. Works from any base CV (including a PDF). Auto-PDF is reliable here.
- **Designed Word templates** (Simple Objective, Classic Header, ATS Clean, Photo — Modern, etc.) — your tailored content is poured into a real `.docx` design. The **Word file is the accurate, editable output**; an auto-PDF is produced best-effort (some designed templates add blank pages under LibreOffice — open the Word file and "Save as PDF" for a clean one).
- **My Word template** — if your selected CV is a `.docx`, the app rewrites that file in place.
- **Plain text** — text-only tailoring.

**Profile photo:** upload a headshot on the **Base CV** page. Photo templates (e.g. *Photo — Modern*) insert it automatically (cropped square); other templates ignore it. Add new gallery designs by dropping a `.docx` into `server/templates/docx/` and registering it in `server/services/templates.ts`.

## Current Limitations

- **Editing a designed PDF directly is not supported** — gallery templates produce a PDF (and HTML). For an editable Word file, use the *My Word template* option with your own `.docx`.
- Rewriting an arbitrary uploaded PDF *in its original design* is not possible (a PDF is a fixed layout). Use a gallery template or a Word source instead.
- **Automatic PDF export of the tailored CV needs LibreOffice** installed (`soffice`). Without it you still get the exact-format Word file — open it and "Save as PDF", or install LibreOffice for one-click PDFs.
- Job search currently depends on Tavily plus generated search queries. For very broad market coverage, more direct providers/adapters should be added.
- The apply worker is intentionally conservative. It opens/checks application flows and records evidence, but it stops before risky or final-submit actions unless a safe site-specific adapter exists.
- Email verification and account-creation automation are not implemented.

## Requirements

- Node.js 20 LTS or newer
- A Tavily API key for job search
- An OpenRouter API key for model routing, ranking, CV tailoring, and cover letter generation
- Optional for browser automation:
  ```bash
  npx playwright install chromium
  ```
- Optional for automatic PDF export of tailored CVs (macOS):
  ```bash
  brew install --cask libreoffice
  ```
  You can also set `LIBREOFFICE_PATH` in `.env` to point at a `soffice` binary.

## Quick Start

### macOS

Double-click:

```text
run-mac.command
```

If macOS blocks it the first time, right-click the file, choose Open, then approve.

### Windows

Double-click:

```text
run-windows.bat
```

### Manual Run

```bash
cp .env.example .env
npm install
npm run prisma:push
npm run dev
```

The app opens at:

```text
http://127.0.0.1:4173
```

The API runs at:

```text
http://127.0.0.1:4100
```

## First Setup

Open `Settings`.

1. Paste your OpenRouter API key.
2. Paste your Tavily API key.
3. Click `Save API Keys`.
4. Confirm the status says:
   - `OpenRouter saved`
   - `Tavily saved`
5. Click `Test OpenRouter`.
6. Choose models for:
   - Search
   - Tailor
   - Apply
   - General

Do not paste real API keys into chat or commit them to git. Use the Settings UI or your local `.env`.

## Recommended Workflow

### 1. Import Your Materials

Go to `Base CV`.

You can import:

- PDF CVs
- Word/DOCX CVs
- JSON CVs
- TXT/MD notes
- certificates
- project descriptions
- detailed personal experience notes

Folder import stores every supported file, not just one CV.

### 2. Select The CV Template

Go to `CV Versions`.

Choose the CV that should act as your template and click:

```text
Use as Template
```

This template is the base for all job-specific CV drafts. Other uploaded materials are used as supporting evidence.

### 3. Search Jobs

Go to `Job Search`.

Fill:

- `City / location`: for example `Vienna`, `Austria`, `Germany`, `Europe remote`
- `What are you looking for?`: describe the kind of job in normal language

Example:

```text
Software developer or AI automation role where petroleum engineering and energy-sector experience are useful. I prefer TypeScript, Python, Playwright, AI tools, and product companies.
```

The app expands this into many targeted search queries, dedupes results, ranks them, and saves the search history.

### 4. Prepare Documents

Open a job from the ranked list.

Click:

```text
Prepare Materials
```

The app uses:

- selected template CV
- all uploaded supporting profile materials
- job description
- extra instructions you provide

It creates:

- tailored CV draft (exact-format Word file when the template CV is a `.docx`, plus a PDF if LibreOffice is installed)
- cover letter
- requirements checklist

Download the tailored CV as **Word**, **PDF**, or plain **text** from the job detail page.

The model is instructed not to invent experience. Missing requirements should appear in the checklist, not be falsely added to the CV.

### 5. Assisted Apply

After preparing materials, use the apply worker. Two modes:

- **Dry run only** (checkbox on): opens the posting headlessly and reports CAPTCHA/login/policy blockers. Nothing is filled or submitted.
- **Auto-fill & Apply** (Dry run off): opens a **visible** browser, pre-fills your name/email/phone and **attaches your tailored CV** on supported ATS (Greenhouse/Lever/Ashby), then **hands the window to you** to solve any CAPTCHA and click Submit yourself. The window stays open until you finish.

It records an `ApplicationRun` with steps and screenshots. **It never bypasses CAPTCHAs and never clicks the final Submit for you** — that's intentional (defeating anti-bot controls violates site terms and risks account bans). It still hard-stops on manual-only domains (e.g. LinkedIn).

## Safety Model

The app is designed to avoid unsafe blind automation.

Domain policy examples:

- `linkedin.com`: manual-only
- `greenhouse.io`: allowed with review gates
- `lever.co`: allowed with review gates
- `workdayjobs.com`: assisted-only

CAPTCHA and anti-bot challenges always stop automation.

## Environment Variables

Real `.env` files are ignored by git.

Common variables:

```bash
DATABASE_URL="file:./dev.db"
OPENROUTER_API_KEY=""
TAVILY_API_KEY=""
ENCRYPTION_KEY="replace-with-32-byte-base64-or-hex-key"
DEFAULT_AUTONOMY_LEVEL="L1"
DEFAULT_CITY=""
SEARCH_MODEL=""
TAILOR_MODEL="anthropic/claude-sonnet-4.5"
APPLY_MODEL="anthropic/claude-sonnet-4.5"
GENERAL_MODEL="anthropic/claude-sonnet-4.5"
SEARCH_TARGET_RESULTS="500"
PORT="4100"
```

Saved keys from the Settings UI take priority over `.env` keys.

## Developer Commands

```bash
npm run local
npm run dev
npm run prisma:push
npm run typecheck
npm run build
npm run start
```

`npm run dev` starts:

- API server on `127.0.0.1:4100`
- Vite UI on `127.0.0.1:4173`

`npm run build && npm run start` serves the built UI and API from the production server.

## UI Tests

End-to-end UI tests live in `uitests/scenarios/` and run through the
[ui-test-pilot](../ui-test-pilot) Playwright runner. They cover the dashboard,
settings, base CV import, template selection, job search, exact-format Word/PDF
tailoring, and the apply worker.

The runner needs Node 22. With the app running (`npm run dev`):

```bash
nvm use 22
npm run uitests          # full regression (all scenarios)
```

Or run/author a single scenario:

```bash
node ../ui-test-pilot/dist/cli.js run uitests/scenarios/prepare/exact-format-and-apply.json
```

## Data Storage

Local data is stored in SQLite through Prisma.

Stored entities include:

- CV versions
- selected template CV setting
- jobs
- search runs
- document sets
- application runs
- encrypted credentials
- audit events

## Troubleshooting

### Tavily says missing API key

Go to `Settings`, paste the Tavily key, click `Save API Keys`, and confirm `Tavily saved`.

### OpenRouter rejects document generation

Go to `Settings`, paste a valid OpenRouter key, click `Save API Keys`, then `Test OpenRouter`.

If the key works but generation fails, choose a stronger Tailor Model.

### Frontend changed but backend still behaves old

Restart the app:

```bash
npm run local
```

### Playwright apply worker cannot run

Install Chromium:

```bash
npx playwright install chromium
```

## Roadmap

- Exact DOCX/PDF template rewriting and export
- Site-specific ATS adapters for Greenhouse, Lever, Workday, Ashby, and others
- Safer final-submit approval workflow
- Email verification support with explicit user permission
- More job search providers beyond Tavily
- Better duplicate detection and company normalization
