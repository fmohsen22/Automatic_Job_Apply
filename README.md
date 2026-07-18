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

When you generate materials for a job you choose an **Output format / template** from a visual gallery — every template shows a **preview thumbnail** so you can see the design before picking it. **Every format produces an editable Word (.docx) file** so you can always fine-tune the result yourself:

- **Navy / Energy** — an HTML-rendered design; your tailored content becomes a polished **PDF** plus a clean editable **Word** version of the same content. Works from any base CV (including a PDF). Auto-PDF is reliable here.
- **Designed Word templates** (Simple Objective, Classic Header, ATS Clean, Photo — Modern, etc.) — your tailored content is poured into a real `.docx` design. The **Word file is the accurate, editable output**; an auto-PDF is produced best-effort (some designed templates add blank pages under LibreOffice — open the Word file and "Save as PDF" for a clean one).
- **My Word template** — if your selected CV is a `.docx`, the app rewrites that file in place.
- **Plain text** — text-only tailoring, plus an auto-built editable **Word** version.

**Profile photo:** upload a headshot on the **Base CV** page. Photo templates (e.g. *Photo — Modern*) insert it automatically (cropped square); other templates ignore it. Add new gallery designs by dropping a `.docx` into `server/templates/docx/` and registering it in `server/services/templates.ts`.

## Current Limitations

- **Editing a designed PDF directly is not supported** — but every format now also produces an editable Word file, so edit the `.docx` and export a fresh PDF from Word if needed.
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

## Quick Start (step by step)

The only thing you must install is **Node.js**. No Python, no Java, no database server.
You also need two free API keys: **OpenRouter** (the AI) from <https://openrouter.ai/keys>, and **Tavily** (job search) from <https://app.tavily.com>.

### macOS

```bash
# 1. Install Node.js + Git with Homebrew.
#    (If you don't have Homebrew, install it first:)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git

# 2. (Optional) LibreOffice — for one-click PDF of Word templates:
brew install --cask libreoffice

# 3. Get the app:
git clone https://github.com/fmohsen22/Automatic_Job_Apply.git
cd Automatic_Job_Apply

# 4. Install dependencies and the browser used for apply + designed PDFs:
npm install
npx playwright install chromium

# 5. Run it (creates the config + database and opens your browser):
npm run local
```

### Windows (PowerShell)

```powershell
# 1. Install Node.js + Git with winget, then CLOSE and reopen the terminal so PATH updates.
winget install OpenJS.NodeJS.LTS
winget install Git.Git

# 2. (Optional) LibreOffice — for one-click PDF of Word templates:
winget install TheDocumentFoundation.LibreOffice

# 3. Get the app:
git clone https://github.com/fmohsen22/Automatic_Job_Apply.git
cd Automatic_Job_Apply

# 4. Install dependencies and the browser used for apply + designed PDFs:
npm install
npx playwright install chromium

# 5. Run it (creates the config + database and opens your browser):
npm run local
```

> No Git? Download the repo as a ZIP from GitHub, unzip it, then `cd` into the folder and start at step 4.
> Prefer double-clicking? After step 4, use `run-mac.command` (macOS) or `run-windows.bat` (Windows) instead of `npm run local`.

### After it opens (http://127.0.0.1:4173)

1. **Settings** → paste your **OpenRouter** and **Tavily** keys → Save.
2. **Base CV** → upload your one main CV (a Word `.docx` keeps your exact layout; PDF also works). It is saved and set as your template automatically — the page confirms "This is your base CV". Optionally add a photo.
3. **My Materials** → add everything else: certificates, other CVs, reference letters, and pasted text/personal info. All of it becomes evidence the AI can draw from.
4. **Job Search** → describe what you want in plain language and search — or use **Found a job yourself?** to add a job by **link, pasted text, or an uploaded PDF / Word doc / screenshot** (handy for login-only sites).
5. Open a job → pick a template → **Generate Materials** → download Word / PDF.

The first run downloads dependencies and a browser (a few minutes); later runs start in seconds. Stop the app with `Ctrl+C`. The web UI is at `http://127.0.0.1:4173` and the API at `http://127.0.0.1:4100`.

### Restart later

```bash
cd Automatic_Job_Apply
npm run local
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
   - Review
   - General

### Using your ChatGPT plan instead of OpenRouter (optional)

If you already pay for ChatGPT, every model dropdown has **Codex — your ChatGPT plan** pinned at the top. Picking it routes that step through the local [Codex CLI](https://github.com/openai/codex) using your existing subscription — no OpenRouter credit spent. You can also mix (e.g. Codex for tailoring, a cheap OpenRouter model for search) or switch back and forth to compare results.

Requirements: install the Codex CLI and log in once with `codex login`. The app detects it automatically and shows its status in the dropdown; if it isn't installed the option explains what to do. The CLI is run in a read-only sandbox against an empty temp folder, and your credentials never pass through the app.

Do not paste real API keys into chat or commit them to git. Use the Settings UI or your local `.env`.

## Recommended Workflow

### 1. Set Your Base CV

Go to `Base CV` and upload your one main CV (Word `.docx` recommended so tailored CVs keep your exact layout; PDF works too).

It is saved and **set as your template automatically** — the page always shows a card confirming which CV is your base. Uploading a new file replaces it (the old one stays in My Materials as evidence). This is also where your profile photo lives.

### 2. Add Everything Else in My Materials

Go to `My Materials` — the one place for all supporting input:

- PDF / Word / JSON CVs
- TXT/MD notes
- certificates
- project descriptions
- detailed personal experience notes
- **pasted text** — use the "Paste text" card to type or paste anything (projects, certificates, achievements, references)

Folder import stores every supported file, not just one CV. Everything here is **evidence**: the AI pulls in whatever is relevant for each job when tailoring.

You can add several CVs, but exactly **one** (your Base CV) acts as the template for formatting. To promote a different CV, click `Use as Template` on it in My Materials — or just upload it on the Base CV page.

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

**Truthfulness guarantee:** every generation prompt instructs the model to use ONLY facts from your uploaded materials — never invent employers, titles, dates, degrees, certificates, skills, or metrics. The reviewer model cross-checks each claim in the draft against your original CV and flags anything unsupported, and the refine step removes flagged content. Missing requirements appear in the checklist as gaps — never falsely added to the CV.

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
