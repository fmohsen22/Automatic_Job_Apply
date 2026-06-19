import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarX2,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  FilePenLine,
  FileText,
  FileUp,
  Gauge,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  WandSparkles,
  XCircle
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./styles.css";

type View = "dashboard" | "search" | "job-detail" | "settings" | "base-cv" | "versions" | "audit";
type AutonomyLevel = "L0" | "L1" | "L2";
type ApiState<T> = { data: T; loading: boolean; error: string | null };

type DashboardSummary = {
  counts: {
    jobs: number;
    cvVersions: number;
    docSets: number;
    runs: number;
    searchRuns?: number;
  };
  auditEvents: AuditEvent[];
  policies: Array<{
    domain: string;
    mode: "allowed" | "assisted-only" | "manual-only";
    risk: "low" | "medium" | "high";
    warning?: string;
  }>;
};

type SettingsPayload = {
  openrouterApiKey?: string;
  tavilyApiKey?: string;
  defaultCity?: string;
  defaultAutonomyLevel?: AutonomyLevel;
  searchModel?: string;
  tailorModel?: string;
  reviewModel?: string;
  applyModel?: string;
  generalModel?: string;
  openrouterApiKeySet?: boolean;
  openrouterApiKeyStored?: boolean;
  tavilyApiKeySet?: boolean;
  tavilyApiKeyStored?: boolean;
};

type CvVersion = {
  id: string;
  cvKey?: string;
  version?: number;
  label: string;
  source?: string | null;
  assetType?: string | null;
  includeEvidence?: boolean;
  json: unknown;
  createdAt: string;
};

type AuditEvent = {
  id: string;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  summary: string;
  metadata?: string | null;
  createdAt: string;
};

type OpenRouterModel = {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
  category: "search" | "tailor" | "apply" | "general";
};

type ModelPurpose = "search" | "tailor" | "review" | "apply" | "general";

type Job = {
  id: string;
  source: string;
  url: string;
  company: string;
  title: string;
  location?: string | null;
  descr: string;
  fitScore: number;
  fitReasons: string[];
  status: string;
  updatedAt: string;
  gated?: boolean;
};

type SearchRun = {
  id: string;
  role: string;
  city: string;
  maxResults: number;
  status: string;
  resultCount: number;
  queries: string[];
  createdAt: string;
  topJobs?: Job[];
};

type ChecklistItem = {
  requirement: string;
  status: "met" | "missing" | "address";
  evidence?: string;
  plan?: string;
};

type DocSet = {
  id: string;
  coverLetter?: string | null;
  checklist: ChecklistItem[];
  status: string;
  createdAt: string;
  cvVersion: CvVersion;
  formatMode?: "template" | "docx" | "text";
  templateId?: string | null;
  cvDocxAvailable?: boolean;
  cvPdfAvailable?: boolean;
  cvHtmlAvailable?: boolean;
};

type TemplateInfo = { id: string; name: string; description: string; kind: "html" | "docx"; needsPhoto?: boolean };

type ApplicationStep = {
  label: string;
  status: "ok" | "blocked" | "warning";
  detail: string;
};

type ApplicationRun = {
  id: string;
  autonomyLevel: AutonomyLevel;
  status: string;
  steps: ApplicationStep[];
  screenshots: string[];
  createdAt: string;
};

type JobDetailPayload = Job & {
  docSets: DocSet[];
  runs: ApplicationRun[];
};

const autonomyLabels: Record<AutonomyLevel, string> = {
  L0: "Assist",
  L1: "Semi-auto",
  L2: "Full-auto"
};

const views: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "search", label: "Job Search", icon: Search },
  { id: "settings", label: "Settings", icon: SettingsIcon },
  { id: "base-cv", label: "Base CV", icon: FileUp },
  { id: "versions", label: "CV Versions", icon: FilePenLine },
  { id: "audit", label: "Audit Log", icon: History }
];

const emptySummary: DashboardSummary = {
  counts: { jobs: 0, cvVersions: 0, docSets: 0, runs: 0, searchRuns: 0 },
  auditEvents: [],
  policies: []
};

const emptySettings: SettingsPayload = {
  openrouterApiKey: "",
  tavilyApiKey: "",
  defaultCity: "",
  defaultAutonomyLevel: "L1",
  searchModel: "x-ai/grok-4.3",
  tailorModel: "anthropic/claude-sonnet-4.5",
  reviewModel: "openai/gpt-5.4-mini",
  applyModel: "anthropic/claude-sonnet-4.5",
  generalModel: "anthropic/claude-sonnet-4.5"
};

const fallbackAudit: AuditEvent[] = [
  {
    id: "local-ready",
    action: "frontend.ready",
    entity: "AppShell",
    summary: "M1 frontend shell loaded",
    createdAt: new Date().toISOString()
  }
];

function useApi<T>(path: string, fallback: T): ApiState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<ApiState<T>>({
    data: fallback,
    loading: true,
    error: null
  });

  const refresh = async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as T;
      setState({ data, loading: false, error: null });
    } catch (error) {
      setState({
        data: fallback,
        loading: false,
        error: error instanceof Error ? error.message : "Request failed"
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, [path]);

  return { ...state, refresh };
}

async function sendJson<T>(path: string, method: "POST" | "PUT", payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await responseError(response));
  }

  return (await response.json()) as T;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return (await response.json()) as T;
}

async function responseError(response: Response) {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function App() {
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [selectedJobId, setSelectedJobId] = useState("");

  const openJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setActiveView("job-detail");
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AJ</div>
          <div>
            <strong>Automate Job Apply</strong>
            <span>M3 Preparation</span>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          {views.map((view) => {
            const Icon = view.icon;
            return (
              <button
                className={activeView === view.id ? "nav-item active" : "nav-item"}
                key={view.id}
                onClick={() => setActiveView(view.id)}
                type="button"
              >
                <Icon size={18} />
                {view.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        {activeView === "dashboard" && <Dashboard />}
        {activeView === "search" && <JobSearch onOpenJob={openJob} />}
        {activeView === "job-detail" && (
          <JobDetail
            jobId={selectedJobId}
            onBack={() => setActiveView("search")}
          />
        )}
        {activeView === "settings" && <SettingsPage />}
        {activeView === "base-cv" && <BaseCvImport />}
        {activeView === "versions" && <CvVersions />}
        {activeView === "audit" && <AuditLog />}
      </main>
    </div>
  );
}

function JobSearch({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const settings = useApi<SettingsPayload>("/api/settings", emptySettings);
  const jobs = useApi<Job[]>("/api/jobs", []);
  const searchRuns = useApi<SearchRun[]>("/api/jobs/search-runs", []);
  const [searchText, setSearchText] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isPruning, setIsPruning] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<Job[] | null>(null);
  const [activeRunId, setActiveRunId] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addCompany, setAddCompany] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addFile, setAddFile] = useState<File | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addStatus, setAddStatus] = useState("");
  const [hideGated, setHideGated] = useState(() => {
    try { return localStorage.getItem("hideGatedJobs") !== "false"; } catch { return true; }
  });
  const allDisplayedJobs = historyJobs ?? jobs.data;
  const displayedJobs = hideGated ? allDisplayedJobs.filter((job) => !job.gated) : allDisplayedJobs;
  const hiddenGatedCount = allDisplayedJobs.length - displayedJobs.length;

  useEffect(() => {
    try { localStorage.setItem("hideGatedJobs", String(hideGated)); } catch { /* ignore */ }
  }, [hideGated]);

  useEffect(() => {
    if (!location && settings.data.defaultCity) {
      setLocation(settings.data.defaultCity);
    }
  }, [settings.data.defaultCity, location]);

  const searchJobs = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSearching(true);
    setStatus("Expanding your request into targeted searches, querying job sources, deduping, and ranking matches.");
    try {
      const response = await sendJson<{ jobs: Job[]; expiredFiltered?: number; interpreted?: { roles: string[]; location: string } }>("/api/jobs/search", "POST", { searchText, location });
      const skipped = response.expiredFiltered ?? 0;
      const roles = response.interpreted?.roles?.filter(Boolean).join(", ");
      setStatus(`Found ${response.jobs.length} live jobs${roles ? ` for: ${roles}` : ""}${skipped ? ` (skipped ${skipped} expired)` : ""}`);
      setHistoryJobs(response.jobs);
      setActiveRunId("");
      await jobs.refresh();
      await searchRuns.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const addJob = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!addUrl.trim() && !addDescription.trim() && !addFile) return;
    setIsAdding(true);
    setAddStatus(addFile ? "Reading the file and scoring fit…" : "Reading the job and scoring fit…");
    try {
      const payload: Record<string, unknown> = {
        url: addUrl.trim(),
        title: addTitle.trim(),
        company: addCompany.trim(),
        description: addDescription.trim()
      };
      if (addFile) {
        payload.file = { name: addFile.name, type: addFile.type, contentBase64: await fileToBase64(addFile) };
      }
      const job = await sendJson<Job>("/api/jobs", "POST", payload);
      setAddStatus(`Added “${job.title}” (${job.fitScore}% fit) — opening it…`);
      setAddUrl("");
      setAddTitle("");
      setAddCompany("");
      setAddDescription("");
      setAddFile(null);
      setHistoryJobs(null);
      setActiveRunId("");
      await jobs.refresh();
      onOpenJob(job.id);
    } catch (error) {
      setAddStatus(error instanceof Error ? error.message : "Could not add the job");
    } finally {
      setIsAdding(false);
    }
  };

  const pruneExpired = async () => {
    setIsPruning(true);
    setStatus("Checking which listed jobs are still open…");
    try {
      const result = await sendJson<{ checked: number; expired: number }>("/api/jobs/prune-expired", "POST", {});
      setStatus(`Checked ${result.checked} jobs — hid ${result.expired} expired.`);
      setHistoryJobs(null);
      setActiveRunId("");
      await jobs.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not check job freshness");
    } finally {
      setIsPruning(false);
    }
  };

  const loadSearchRun = async (runId: string) => {
    setStatus("Loading search history");
    try {
      const run = await fetchJson<SearchRun & { jobs: Job[] }>(`/api/jobs/search-runs/${runId}`);
      setHistoryJobs(run.jobs);
      setActiveRunId(run.id);
      setSearchText(run.role);
      setLocation(run.city === "Any" ? "" : run.city);
      setStatus(`Loaded ${run.resultCount} saved results`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load search history");
    }
  };

  return (
    <>
      <PageHeader
        title="Job Search"
        description="Describe what you want in natural language. The app expands it into many targeted searches and saves each history."
        action={
          <div style={{ display: "flex", gap: "10px" }}>
            <IconButton
              icon={CalendarX2}
              label={isPruning ? "Checking…" : "Remove Expired"}
              onClick={() => void pruneExpired()}
              disabled={isPruning || isSearching}
            />
            <IconButton icon={RefreshCw} label="Refresh Jobs" onClick={() => {
              setHistoryJobs(null);
              setActiveRunId("");
              void jobs.refresh();
              void searchRuns.refresh();
            }} primary />
          </div>
        }
      />
      <form className="panel search-form intent-search-form" onSubmit={(event) => void searchJobs(event)}>
        <Field label="City / location">
          <input
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Vienna, Austria, Europe remote, Germany, ..."
            type="text"
            value={location}
          />
        </Field>
        <Field label="What are you looking for?">
          <textarea
            className="search-intent"
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Example: I want software developer roles in Vienna or remote across Austria/Germany. I prefer backend, automation, AI tools, TypeScript, Python, Playwright, and startups or product companies. I need English-speaking roles and visa-friendly companies."
            value={searchText}
          />
        </Field>
        <div className="form-footer">
          <span className={isSearching ? "loading-status" : ""}>
            {status || "The backend searches many targeted job and ATS patterns, dedupes results, and saves the history."}
          </span>
          <IconButton
            icon={Search}
            label={isSearching ? "Searching..." : "Search Jobs"}
            primary
            submit
            disabled={isSearching || searchText.trim().length < 5}
          />
        </div>
      </form>
      <form className="panel add-job-form" onSubmit={(event) => void addJob(event)}>
        <div className="panel-header">
          <h2>Found a job yourself?</h2>
          <span>Add it, then prepare your CV</span>
        </div>
        <Field label="Job URL">
          <input
            onChange={(event) => setAddUrl(event.target.value)}
            placeholder="https://… (paste the job link — we read the title, company & description)"
            type="url"
            value={addUrl}
          />
        </Field>
        <div className="add-job-row">
          <Field label="Title (optional)">
            <input onChange={(event) => setAddTitle(event.target.value)} placeholder="e.g. Senior AI Engineer" type="text" value={addTitle} />
          </Field>
          <Field label="Company (optional)">
            <input onChange={(event) => setAddCompany(event.target.value)} placeholder="e.g. Acme Energy" type="text" value={addCompany} />
          </Field>
        </div>
        <Field label="Or paste the job description (if the site can’t be read)">
          <textarea
            className="compact-textarea"
            onChange={(event) => setAddDescription(event.target.value)}
            placeholder="Optional: paste the role title and description here."
            value={addDescription}
          />
        </Field>
        <Field label="Or upload the job description — PDF, Word, or a screenshot (great for login-only sites)">
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,image/*"
            onChange={(event) => setAddFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <div className="form-footer">
          <span className={isAdding ? "loading-status" : ""}>
            {addStatus || "Paste a link, paste text, or upload a PDF/Word/screenshot — we read it, score the fit, and open it for preparation."}
          </span>
          <IconButton
            icon={Plus}
            label={isAdding ? "Adding…" : "Add & Open"}
            primary
            submit
            disabled={isAdding || (!addUrl.trim() && !addFile && addDescription.trim().length < 20)}
          />
        </div>
      </form>
      <section className="search-workspace">
        <div className="panel history-panel">
          <div className="panel-header">
            <h2>Search History</h2>
            <span>{searchRuns.loading ? "Loading" : `${searchRuns.data.length} runs`}</span>
          </div>
          {searchRuns.data.length === 0 ? <p className="empty-state">No saved searches yet.</p> : null}
          <div className="history-list">
            {searchRuns.data.map((run) => (
              <button
                className={activeRunId === run.id ? "history-row active" : "history-row"}
                key={run.id}
                onClick={() => void loadSearchRun(run.id)}
                type="button"
              >
                <strong>{run.role}</strong>
                <span>{run.city === "Any" ? "" : `${run.city} - `}{run.resultCount} jobs - {formatDate(run.createdAt)}</span>
                <StatusPill state={run.status === "COMPLETED" ? "online" : run.status === "FAILED" ? "offline" : "warning"} label={titleCase(run.status)} />
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <h2>{activeRunId ? "Saved Search Results" : "Ranked Jobs"}</h2>
            <span>{jobs.loading ? "Loading" : jobs.error ? `Offline: ${jobs.error}` : `${displayedJobs.length} shown`}</span>
          </div>
          <label className="gated-toggle">
            <input type="checkbox" checked={hideGated} onChange={(event) => setHideGated(event.target.checked)} />
            <span>Hide login-only sites (LinkedIn, Glassdoor, Indeed…){hiddenGatedCount ? ` — ${hiddenGatedCount} hidden` : ""}</span>
          </label>
          {displayedJobs.length === 0 ? <p className="empty-state">{hideGated && hiddenGatedCount ? "All matches are on login-only sites — untick the box above to see them." : "No jobs yet. Run a search after saving your Tavily key."}</p> : null}
          <div className="job-list">
            {displayedJobs.map((job) => (
              <article className="job-card" key={job.id}>
                <div className="job-main">
                  <div>
                    <span className="job-company">{job.company}</span>
                    <h3>{job.title}</h3>
                    <p>{job.location ?? "Location not specified"} - {job.source} - {formatDate(job.updatedAt)}</p>
                  </div>
                  <StatusPill state={job.fitScore >= 75 ? "online" : job.fitScore >= 50 ? "warning" : "offline"} label={`${job.fitScore}% fit`} />
                </div>
                <p className="job-description">{job.descr}</p>
                <ul className="reason-list">
                  {job.fitReasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
                <div className="job-actions">
                  <button className="button primary icon-button" onClick={() => onOpenJob(job.id)} type="button">
                    <WandSparkles size={17} />
                    <span>Review & Prepare</span>
                  </button>
                  <a className="button icon-button" href={job.url} rel="noreferrer" target="_blank">
                    <ExternalLink size={17} />
                    <span>Open Posting</span>
                  </a>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function JobDetail({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const { data, loading, error, refresh } = useApi<JobDetailPayload | null>(jobId ? `/api/jobs/${jobId}` : "/api/jobs/missing", null);
  const template = useApi<CvVersion | null>("/api/cv/template", null);
  const templates = useApi<TemplateInfo[]>("/api/templates", []);
  const [instructions, setInstructions] = useState("");
  const [format, setFormat] = useState("");
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>("L1");
  const [dryRun, setDryRun] = useState(true);
  const [status, setStatus] = useState("");
  const [isPreparing, setIsPreparing] = useState(false);
  const [applyStatus, setApplyStatus] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const latestDocSet = data?.docSets?.[0];
  const latestRun = data?.runs?.[0];
  const templateIsDocx = template.data?.assetType === "docx";

  const selectedTemplate = templates.data.find((t) => t.id === format);

  useEffect(() => {
    // Wait until both the template CV and the gallery list have loaded, then
    // default to the user's own .docx ("word") if they have one, else the first
    // designed template.
    if (format || templates.loading || template.loading) return;
    setFormat(templateIsDocx ? "word" : (templates.data[0]?.id ?? "text"));
  }, [format, templates.loading, templates.data, template.loading, templateIsDocx]);

  const prepare = async () => {
    if (!jobId) return;
    setIsPreparing(true);
    setStatus("Tailoring your CV, writing a cover letter, and building the requirements checklist…");
    try {
      await sendJson<DocSet>(`/api/jobs/${jobId}/prepare`, "POST", { instructions, template: format });
      setStatus("Done — your tailored materials are ready below.");
      setInstructions("");
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Preparation failed");
    } finally {
      setIsPreparing(false);
    }
  };

  const apply = async () => {
    if (!jobId) return;
    setIsApplying(true);
    setApplyStatus(dryRun ? "Running browser dry-run…" : "Starting assisted browser apply…");
    try {
      const run = await sendJson<ApplicationRun>(`/api/jobs/${jobId}/apply`, "POST", { autonomyLevel, dryRun });
      setApplyStatus(`Worker finished: ${titleCase(run.status)}`);
      await refresh();
    } catch (error) {
      setApplyStatus(error instanceof Error ? error.message : "Apply worker failed");
    } finally {
      setIsApplying(false);
    }
  };

  if (!jobId) {
    return (
      <>
        <PageHeader title="Job Detail" description="No job selected." action={<IconButton icon={ArrowLeft} label="Back to Search" onClick={onBack} />} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data ? data.title : "Job Detail"}
        description={data ? `${data.company} - ${data.location ?? "Location not specified"}` : "Loading selected job."}
        action={<IconButton icon={ArrowLeft} label="Back to Search" onClick={onBack} />}
      />
      {error ? <section className="status-strip"><StatusPill state="offline" label="Offline" /><span>{error}</span></section> : null}
      {loading && !data ? <section className="panel"><p className="empty-state">Loading job.</p></section> : null}
      {data ? (
        <section className="detail-grid">
          <div className="panel job-detail-panel">
            <div className="panel-header">
              <h2>Job Info</h2>
              <StatusPill state={data.fitScore >= 75 ? "online" : data.fitScore >= 50 ? "warning" : "offline"} label={`${data.fitScore}% fit`} />
            </div>
            <p className="job-description-full">{data.descr}</p>
            <ul className="reason-list">
              {data.fitReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            <a className="button icon-button detail-link" href={data.url} rel="noreferrer" target="_blank">
              <ExternalLink size={17} />
              <span>Open Original Posting</span>
            </a>
          </div>
          <div className="panel prep-panel">
            <div className="panel-header">
              <h2>Generate / Update CV</h2>
              <span>{data.docSets.length} draft{data.docSets.length === 1 ? "" : "s"}</span>
            </div>
            <p className="prep-intro">Rewrites your template CV for this job, writes a matching cover letter, and builds a requirements checklist — using only your real experience.</p>
            <div className={`prep-template ${template.data ? "ok" : "warn"}`}>
              <FileText size={18} />
              {template.data ? (
                <div>
                  <strong>Source CV: {template.data.label}</strong>
                  <span>Your real content is tailored into the output format you pick below.</span>
                </div>
              ) : (
                <div>
                  <strong>No CV imported yet</strong>
                  <span>Import a CV in Base CV first.</span>
                </div>
              )}
            </div>
            <div className="field">
              <span>Output format / template</span>
              <select
                aria-label="Output format"
                value={format}
                onChange={(event) => setFormat(event.target.value)}
                disabled={isPreparing}
              >
                {templateIsDocx ? (
                  <optgroup label="Your own CV">
                    <option value="word">My CV — {template.data?.label} (exact layout)</option>
                  </optgroup>
                ) : null}
                <optgroup label="Designed templates">
                  {templates.data.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}{t.needsPhoto ? " (photo)" : ""}</option>
                  ))}
                </optgroup>
                <optgroup label="Plain">
                  <option value="text">Plain text</option>
                </optgroup>
              </select>
              {format === "word" ? (
                <p className="format-hint">Your uploaded Word CV, rewritten in place for this job — your exact layout is preserved.</p>
              ) : selectedTemplate ? (
                <p className="format-hint">{selectedTemplate.description}</p>
              ) : null}
              {!templateIsDocx ? (
                <p className="format-hint photo">Want your <strong>own exact design</strong> as a template? Upload your CV as a Word <strong>.docx</strong> on the Base CV page — it then appears here as “My CV”. (A PDF can’t be reproduced exactly.)</p>
              ) : null}
              {selectedTemplate?.needsPhoto ? (
                <p className="format-hint photo">Uses a profile photo — upload one in <strong>Base CV</strong> for best results (otherwise the sample photo stays and you can replace it in Word).</p>
              ) : null}
            </div>
            <Field label="Extra instructions (optional)">
              <textarea
                className="compact-textarea"
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Example: emphasize automation and energy-sector experience, keep it to one page, address relocation."
                value={instructions}
                disabled={isPreparing}
              />
            </Field>
            <button
              className="button primary prep-button"
              onClick={() => void prepare()}
              type="button"
              disabled={isPreparing || !template.data}
            >
              {isPreparing ? <Loader2 className="spin" size={18} /> : <WandSparkles size={18} />}
              <span>{isPreparing ? "Generating…" : data.docSets.length ? "Regenerate Materials" : "Generate Materials"}</span>
            </button>
            {isPreparing || status ? (
              <p className={`prep-status${isPreparing ? " loading" : ""}`}>
                {status}{isPreparing ? " (usually 20–40s)" : ""}
              </p>
            ) : null}
          </div>
          <div className="panel apply-panel">
            <div className="panel-header">
              <h2>Apply Worker</h2>
              <span>{data.runs.length} runs</span>
            </div>
            <p className="prep-intro">
              {dryRun
                ? "Dry run: opens the posting headlessly and checks for CAPTCHA/login blockers. Nothing is filled or submitted."
                : "Assisted apply: opens a visible browser, pre-fills your details and attaches your tailored CV, then hands off to you to solve any CAPTCHA and click Submit. It never bypasses CAPTCHAs or submits on its own."}
            </p>
            <Field label="Autonomy">
              <select onChange={(event) => setAutonomyLevel(event.target.value as AutonomyLevel)} value={autonomyLevel}>
                <option value="L0">Assist</option>
                <option value="L1">Semi-auto</option>
                <option value="L2">Full-auto</option>
              </select>
            </Field>
            <label className="toggle-row">
              <input checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} type="checkbox" />
              <span>Dry run only (check, don’t fill)</span>
            </label>
            <div className="form-footer">
              <span>{applyStatus || (latestDocSet ? "Stops at CAPTCHA, login, and final submit for you to handle." : "Generate materials first to enable apply.")}</span>
              <button className="button primary icon-button" type="button" onClick={() => void apply()} disabled={!latestDocSet || isApplying}>
                {isApplying ? <Loader2 className="spin" size={17} /> : <ExternalLink size={17} />}
                <span>{isApplying ? "Working…" : dryRun ? "Run Browser Check" : "Auto-fill & Apply"}</span>
              </button>
            </div>
          </div>
          <div className="panel materials-panel">
            <div className="panel-header">
              <h2>Prepared Materials</h2>
              <span className="materials-meta">
                {latestDocSet ? (
                  <>
                    <StatusPill state="draft" label={titleCase(latestDocSet.status)} />
                    {formatDate(latestDocSet.createdAt)}
                  </>
                ) : "No draft yet"}
              </span>
            </div>
            {isPreparing && !latestDocSet ? (
              <div className="generating-card">
                <Loader2 className="spin" size={22} />
                <div>
                  <strong>Tailoring your CV to this job…</strong>
                  <span>Writing the CV, cover letter, and requirements checklist. This usually takes 20–40 seconds.</span>
                </div>
              </div>
            ) : null}
            {!latestDocSet && !isPreparing ? <p className="empty-state">Click “Generate Materials” to create a tailored CV, cover letter, and requirements checklist.</p> : null}
            {latestDocSet ? (
              <div className="materials-grid">
                <section className="material-card cv-card">
                  <div className="materials-section-header">
                    <div className="ms-title">
                      <FileText size={16} />
                      <h3>Tailored CV</h3>
                      {latestDocSet.formatMode === "template"
                        ? <StatusPill state="online" label={`Designed${latestDocSet.templateId ? ` · ${titleCase(latestDocSet.templateId)}` : ""}`} />
                        : latestDocSet.formatMode === "docx"
                          ? <StatusPill state="online" label="Exact Word format" />
                          : <StatusPill state="warning" label="Text only" />}
                    </div>
                    <div className="download-group">
                      {latestDocSet.cvDocxAvailable ? (
                        <a className="button primary icon-button small" href={`/api/docsets/${latestDocSet.id}/cv.docx`}>
                          <Download size={14} />
                          <span>Word</span>
                        </a>
                      ) : null}
                      {latestDocSet.cvPdfAvailable ? (
                        <a className={latestDocSet.cvDocxAvailable ? "button icon-button small" : "button primary icon-button small"} href={`/api/docsets/${latestDocSet.id}/cv.pdf`}>
                          <Download size={14} />
                          <span>PDF</span>
                        </a>
                      ) : null}
                      <button
                        className="button icon-button small"
                        onClick={() => downloadText(`${safeFileName(`${data.company}_${data.title}_CV`)}.txt`, stringifyCv(latestDocSet.cvVersion.json))}
                        type="button"
                      >
                        <Download size={14} />
                        <span>Text</span>
                      </button>
                    </div>
                  </div>
                  {latestDocSet.cvDocxAvailable ? (
                    <p className="materials-note">Open the <strong>Word</strong> file for the exact layout — that's the editable, accurate version. The auto-PDF can add blank pages for some designed templates; for a clean PDF, open the Word file and “Save as PDF”.</p>
                  ) : null}
                  {latestDocSet.cvPdfAvailable && !latestDocSet.cvDocxAvailable ? (
                    <iframe className="pdf-preview" title="Tailored CV preview" src={`/api/docsets/${latestDocSet.id}/cv.pdf#toolbar=0&navpanes=0&view=FitH`} />
                  ) : (
                    <div className="doc-paper">{stringifyCv(latestDocSet.cvVersion.json)}</div>
                  )}
                </section>
                <section className="material-card">
                  <div className="materials-section-header">
                    <div className="ms-title">
                      <FileText size={16} />
                      <h3>Cover Letter</h3>
                    </div>
                    <div className="download-group">
                      <button
                        className="button icon-button small"
                        onClick={() => downloadText(`${safeFileName(`${data.company}_${data.title}_CoverLetter`)}.txt`, latestDocSet.coverLetter || "")}
                        type="button"
                        disabled={!latestDocSet.coverLetter}
                      >
                        <Download size={14} />
                        <span>Text</span>
                      </button>
                    </div>
                  </div>
                  <div className="doc-paper">{latestDocSet.coverLetter || "No cover letter generated."}</div>
                </section>
                <section className="material-card checklist-card">
                  <div className="materials-section-header">
                    <div className="ms-title">
                      <ClipboardList size={16} />
                      <h3>Requirements Checklist</h3>
                    </div>
                  </div>
                  <RequirementsChecklist items={latestDocSet.checklist} />
                </section>
              </div>
            ) : null}
          </div>
          <div className="panel runs-panel">
            <div className="panel-header">
              <h2>Application Runs</h2>
              <span>{latestRun ? `${titleCase(latestRun.status)} - ${formatDate(latestRun.createdAt)}` : "No runs yet"}</span>
            </div>
            {data.runs.length === 0 ? <p className="empty-state">Prepare materials first, then run a browser check or assisted apply.</p> : null}
            <div className="run-list">
              {data.runs.map((run) => (
                <article className="run-card" key={run.id}>
                  <div className="run-card-header">
                    <strong>{titleCase(run.status)}</strong>
                    <span>{autonomyLabels[run.autonomyLevel]} - {formatDate(run.createdAt)}</span>
                  </div>
                  <div className="step-list">
                    {run.steps.map((step) => (
                      <div className="step-row" key={`${run.id}-${step.label}-${step.detail}`}>
                        <StatusPill state={step.status === "ok" ? "online" : step.status === "warning" ? "warning" : "offline"} label={titleCase(step.status)} />
                        <div>
                          <strong>{step.label}</strong>
                          <span>{step.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {run.screenshots.length ? (
                    <div className="screenshot-list">
                      {run.screenshots.map((screenshot) => <code key={screenshot}>{screenshot}</code>)}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

function RequirementsChecklist({ items }: { items: ChecklistItem[] }) {
  if (!items.length) {
    return <p className="empty-state">No checklist items were generated.</p>;
  }
  const met = items.filter((item) => item.status === "met").length;
  const address = items.filter((item) => item.status === "address").length;
  const missing = items.filter((item) => item.status === "missing").length;
  const matchPct = Math.round((met / items.length) * 100);
  const icon = (status: ChecklistItem["status"]) =>
    status === "met" ? <CheckCircle2 size={18} /> : status === "address" ? <AlertTriangle size={18} /> : <XCircle size={18} />;

  return (
    <>
      <div className="checklist-summary">
        <div className="match-meter">
          <div className="match-track"><span className="match-fill" style={{ width: `${matchPct}%` }} /></div>
          <strong>{matchPct}% match</strong>
        </div>
        <div className="checklist-counts">
          <span className="cc met"><CheckCircle2 size={14} /> {met} met</span>
          <span className="cc address"><AlertTriangle size={14} /> {address} to address</span>
          <span className="cc missing"><XCircle size={14} /> {missing} missing</span>
        </div>
      </div>
      <div className="checklist">
        {items.map((item, index) => (
          <div className={`checklist-row ${item.status}`} key={`${item.requirement}-${index}`}>
            <span className="check-icon">{icon(item.status)}</span>
            <div className="check-body">
              <strong>{item.requirement}</strong>
              {item.evidence ? <span><b>Evidence:</b> {item.evidence}</span> : null}
              {item.plan ? <span><b>Plan:</b> {item.plan}</span> : null}
              {!item.evidence && !item.plan ? <span>No detail provided.</span> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PageHeader({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">Local Control Plane</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}

function Dashboard() {
  const { data, loading, error, refresh } = useApi<DashboardSummary>("/api/dashboard/summary", emptySummary);
  const metrics = [
    { label: "Jobs Found", value: data.counts.jobs },
    { label: "Search Runs", value: data.counts.searchRuns ?? 0 },
    { label: "CV Versions", value: data.counts.cvVersions },
    { label: "Document Sets", value: data.counts.docSets },
    { label: "Application Runs", value: data.counts.runs }
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Operational status for local job search automation."
        action={<IconButton icon={RefreshCw} label="Refresh" onClick={() => void refresh()} primary />}
      />
      <section className="status-strip">
        <StatusPill state={error ? "offline" : "online"} label={error ? "Offline" : "Online"} />
        <span>{loading ? "Checking backend" : error ? `API unavailable: ${error}` : "Connected to /api/dashboard/summary"}</span>
      </section>
      <section className="metric-grid" aria-label="Dashboard metrics">
        {metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </article>
        ))}
      </section>
      <section className="panel dashboard-grid">
        <div>
          <div className="panel-header">
            <h2>Recent Activity</h2>
            <span>{data.auditEvents.length || "No"} events</span>
          </div>
          <div className="activity-list">
            {(data.auditEvents.length ? data.auditEvents : fallbackAudit).slice(0, 5).map((event) => (
              <div className="activity-row" key={event.id}>
                <ClipboardList size={18} />
                <div>
                  <strong>{event.summary}</strong>
                  <span>{event.action} - {formatDate(event.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="panel-header">
            <h2>Domain Policy</h2>
            <span>{data.policies.length || "No"} policies</span>
          </div>
          <div className="policy-list">
            {data.policies.slice(0, 5).map((policy) => (
              <div className="policy-row" key={policy.domain}>
                <div>
                  <strong>{policy.domain}</strong>
                  <span>{titleCase(policy.mode)}</span>
                </div>
                <StatusPill state={policy.risk} label={titleCase(policy.risk)} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function SettingsPage() {
  const { data, loading, error, refresh } = useApi<SettingsPayload>("/api/settings", emptySettings);
  const models = useApi<OpenRouterModel[]>("/api/models/openrouter", []);
  const [form, setForm] = useState<SettingsPayload>(emptySettings);
  const [saveState, setSaveState] = useState("");
  const [keySaveState, setKeySaveState] = useState("");
  const [openRouterTestState, setOpenRouterTestState] = useState("");
  const openRouterModels = models.data.length
    ? models.data
    : [{ id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", category: "tailor" as const }];

  useEffect(() => {
    setForm({
      ...emptySettings,
      ...data,
      openrouterApiKey: "",
      tavilyApiKey: ""
    });
  }, [data]);

  useEffect(() => {
    if (models.data.length > 0) {
      setForm((current) => {
        const next: SettingsPayload = { ...current };
        if (!next.searchModel) next.searchModel = chooseModel(models.data, "search")?.id ?? next.searchModel;
        if (!next.tailorModel) next.tailorModel = chooseModel(models.data, "tailor")?.id ?? next.tailorModel;
        if (!next.reviewModel) next.reviewModel = chooseModel(models.data, "review")?.id ?? next.reviewModel;
        if (!next.applyModel) next.applyModel = chooseModel(models.data, "apply")?.id ?? next.applyModel;
        if (!next.generalModel) next.generalModel = chooseModel(models.data, "general")?.id ?? next.generalModel;
        return next;
      });
    }
  }, [models.data.length]);

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveState("Saving");
    try {
      await sendJson("/api/settings", "PUT", form);
      setSaveState("Saved");
      await refresh();
    } catch (saveError) {
      setSaveState(saveError instanceof Error ? saveError.message : "Save failed");
    }
  };

  const saveApiKeys = async () => {
    setKeySaveState("Saving keys");
    try {
      await sendJson("/api/settings", "PUT", form);
      const nextSettings = await fetchJson<SettingsPayload>("/api/settings");
      setKeySaveState([
        nextSettings.openrouterApiKeySet ? "OpenRouter saved" : "OpenRouter missing",
        nextSettings.tavilyApiKeySet ? "Tavily saved" : "Tavily missing"
      ].join(" - "));
      await refresh();
    } catch (saveError) {
      setKeySaveState(saveError instanceof Error ? saveError.message : "Key save failed");
    }
  };

  const testOpenRouter = async () => {
    setOpenRouterTestState("Testing OpenRouter");
    try {
      const result = await sendJson<{ message: string }>("/api/settings/test-openrouter", "POST", {});
      setOpenRouterTestState(result.message);
    } catch (testError) {
      setOpenRouterTestState(testError instanceof Error ? testError.message : "OpenRouter test failed");
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Configure OpenRouter, Tavily, model routing, autonomy level, and search defaults." />
      <form className="panel form-grid" onSubmit={(event) => void saveSettings(event)}>
        <div className="form-section">
          <h2>API Keys</h2>
          <p>Keys are stored encrypted on this computer and are not returned to the browser after saving.</p>
        </div>
        <Field label={`OpenRouter API Key${data.openrouterApiKeyStored ? " - saved in app" : data.openrouterApiKeySet ? " - from .env" : ""}`}>
          <input
            autoComplete="off"
            onChange={(event) => setForm({ ...form, openrouterApiKey: event.target.value })}
            placeholder="Leave blank to keep current key"
            type="password"
            value={form.openrouterApiKey ?? ""}
          />
        </Field>
        <Field label={`Tavily API Key${data.tavilyApiKeyStored ? " - saved in app" : data.tavilyApiKeySet ? " - from .env" : ""}`}>
          <input
            autoComplete="off"
            onChange={(event) => setForm({ ...form, tavilyApiKey: event.target.value })}
            placeholder="Leave blank to keep current key"
            type="password"
            value={form.tavilyApiKey ?? ""}
          />
        </Field>
        <div className="key-status">
          <StatusPill state={data.openrouterApiKeySet ? "online" : "warning"} label={data.openrouterApiKeyStored ? "OpenRouter saved" : data.openrouterApiKeySet ? "OpenRouter .env" : "OpenRouter missing"} />
          <StatusPill state={data.tavilyApiKeySet ? "online" : "warning"} label={data.tavilyApiKeyStored ? "Tavily saved" : data.tavilyApiKeySet ? "Tavily .env" : "Tavily missing"} />
          <span>{openRouterTestState || keySaveState || "Paste keys, then save them here before searching."}</span>
          <button className="button icon-button" onClick={() => void testOpenRouter()} type="button" disabled={!data.openrouterApiKeySet}>
            <RefreshCw size={17} />
            <span>Test OpenRouter</span>
          </button>
          <button className="button primary icon-button" onClick={() => void saveApiKeys()} type="button">
            <Save size={17} />
            <span>Save API Keys</span>
          </button>
        </div>
        <div className="form-section">
          <h2>Model Routing</h2>
          <p>Click a box and type to search all 341 OpenRouter models by name. Recommended: a cheap/fast model for search, Claude for tailoring, a cheap reviewer.</p>
        </div>
        <Field label="Search Model">
          <ModelSelect
            models={openRouterModels}
            purpose="search"
            value={form.searchModel ?? ""}
            onChange={(value) => setForm({ ...form, searchModel: value })}
          />
        </Field>
        <Field label="Tailor Model (generates / updates the CV)">
          <ModelSelect
            models={openRouterModels}
            purpose="tailor"
            value={form.tailorModel ?? ""}
            onChange={(value) => setForm({ ...form, tailorModel: value })}
          />
        </Field>
        <Field label="Review Model (critiques the draft → Tailor refines)">
          <ModelSelect
            models={openRouterModels}
            purpose="review"
            value={form.reviewModel ?? ""}
            onChange={(value) => setForm({ ...form, reviewModel: value })}
          />
        </Field>
        <Field label="Apply Model">
          <ModelSelect
            models={openRouterModels}
            purpose="apply"
            value={form.applyModel ?? ""}
            onChange={(value) => setForm({ ...form, applyModel: value })}
          />
        </Field>
        <Field label="General Model">
          <ModelSelect
            models={openRouterModels}
            purpose="general"
            value={form.generalModel ?? ""}
            onChange={(value) => setForm({ ...form, generalModel: value })}
          />
        </Field>
        <div className="form-hint">
          {models.loading
            ? "Loading OpenRouter model list"
            : models.error
              ? `OpenRouter model list unavailable; using fallback Claude option. ${models.error}`
              : `${models.data.length} OpenRouter models available`}
        </div>
        <div className="form-section">
          <h2>Local Defaults</h2>
          <p>These control the default city and approval behavior for future search, tailoring, and apply runs.</p>
        </div>
        <Field label="Autonomy">
          <select
            onChange={(event) =>
              setForm({ ...form, defaultAutonomyLevel: event.target.value as AutonomyLevel })
            }
            value={form.defaultAutonomyLevel ?? "L1"}
          >
            <option value="L0">Assist</option>
            <option value="L1">Semi-auto</option>
            <option value="L2">Full-auto</option>
          </select>
        </Field>
        <Field label="Default City">
          <input
            onChange={(event) => setForm({ ...form, defaultCity: event.target.value })}
            placeholder="Vienna"
            type="text"
            value={form.defaultCity ?? ""}
          />
        </Field>
        <div className="form-footer">
          <span>{loading ? "Loading settings" : error ? `Using local defaults: ${error}` : saveState}</span>
          <IconButton icon={Save} label="Save Settings" primary submit />
        </div>
      </form>
    </>
  );
}

function BaseCvImport() {
  const [content, setContent] = useState("");
  const [label, setLabel] = useState("Base CV");
  const [mode, setMode] = useState<"text" | "json">("text");
  const [status, setStatus] = useState("");
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [photoStatus, setPhotoStatus] = useState("");
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photoBroken, setPhotoBroken] = useState(false);

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoStatus("Uploading photo…");
    try {
      await sendJson("/api/cv/photo", "POST", { name: file.name, type: file.type, contentBase64: await fileToBase64(file) });
      setPhotoStatus("Photo saved — it will be used by photo templates.");
      setPhotoBroken(false);
      setPhotoVersion((v) => v + 1);
    } catch (error) {
      setPhotoStatus(error instanceof Error ? error.message : "Photo upload failed");
    }
  };

  const importCv = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus("Importing");
    try {
      const parsedContent = mode === "json" ? JSON.parse(content) : content;
      await sendJson("/api/cv", "POST", { label, source: "paste", content: parsedContent });
      setStatus("Imported");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    }
  };

  const submitFiles = async (selected: File[], origin: string) => {
    if (!selected.length) return;
    setStatus(`Importing ${selected.length} ${origin}`);
    try {
      const files = await Promise.all(
        selected.map(async (file) => ({
          name: file.name,
          type: file.type,
          contentBase64: await fileToBase64(file)
        }))
      );
      const imported = await sendJson<CvVersion[]>("/api/cv/import-files", "POST", {
        label: selected.length === 1 ? label.trim() : undefined,
        files
      });
      const word = imported.filter((version) => version.source?.toLowerCase().endsWith(".docx")).length;
      setStatus(`Imported ${imported.length} file(s)${word ? ` — ${word} Word file(s) kept for exact-format tailoring` : ""}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "File import failed");
    }
  };

  return (
    <>
      <PageHeader title="Base CV Import" description="Upload CVs, certificates, profile notes, and evidence documents. Choose one CV as the template in CV Versions." />
      <form className="panel import-panel" onSubmit={(event) => void importCv(event)}>
        <p className="prep-intro">
          One CV is your <strong>template</strong> (its design is used for the “My CV” output and to recreate it). Everything else you add here — extra experiences, certificates, links, project notes — becomes <strong>supporting evidence</strong>: the AI pulls in whatever is relevant to each job when tailoring, without dumping it all in. So feel free to paste lots of detail.
        </p>
        <Field label="Version Label">
          <input onChange={(event) => setLabel(event.target.value)} type="text" value={label} />
        </Field>
        <div className="segmented" role="tablist" aria-label="Import format">
          <button className={mode === "text" ? "selected" : ""} onClick={() => setMode("text")} type="button">
            Text
          </button>
          <button className={mode === "json" ? "selected" : ""} onClick={() => setMode("json")} type="button">
            JSON
          </button>
        </div>
        <textarea
          onChange={(event) => setContent(event.target.value)}
          placeholder={mode === "json" ? "{ \"summary\": \"...\", \"experience\": [] }" : "Paste CV text, certificates, project notes, achievements, or detailed background information here"}
          spellCheck={false}
          value={content}
        />
        <div className="folder-import">
          <div>
            <strong>Upload CV / certificates (recommended)</strong>
            <p>Pick one or more files. Upload your CV as <strong>Word (.docx)</strong> so tailored CVs keep your exact layout. PDF, DOCX, JSON, TXT, and MD are supported.</p>
          </div>
          <input
            multiple
            onChange={(event) => setPickedFiles(Array.from(event.target.files ?? []))}
            type="file"
            accept=".docx,.pdf,.json,.txt,.md"
          />
          <button className="button" onClick={() => void submitFiles(pickedFiles, "files")} type="button" disabled={!pickedFiles.length}>
            Upload Files
          </button>
        </div>
        <div className="folder-import">
          <div>
            <strong>Folder import</strong>
            <p>Or choose a whole folder of CVs, certificates, and profile documents at once.</p>
          </div>
          <input
            multiple
            onChange={(event) => setFolderFiles(Array.from(event.target.files ?? []))}
            type="file"
            webkitdirectory="true"
          />
          <button className="button" onClick={() => void submitFiles(folderFiles, "folder files")} type="button" disabled={!folderFiles.length}>
            Import Folder
          </button>
        </div>
        <div className="form-footer">
          <span>{status}</span>
          <IconButton icon={FileUp} label="Import Base CV" primary submit disabled={!content.trim() || !label.trim()} />
        </div>
      </form>
      <section className="panel photo-panel">
        <div className="panel-header">
          <h2>Profile Photo</h2>
          <span>Used by photo templates</span>
        </div>
        <div className="photo-row">
          <img
            className="photo-thumb"
            style={{ display: photoBroken ? "none" : "block" }}
            src={`/api/cv/photo?v=${photoVersion}`}
            alt="Profile"
            onError={() => setPhotoBroken(true)}
            onLoad={() => setPhotoBroken(false)}
          />
          <div className="photo-controls">
            <p>Upload a headshot. Photo templates (e.g. <strong>Photo — Modern</strong>) will use it automatically; other templates ignore it. It’s cropped to a square.</p>
            <input type="file" accept="image/*" onChange={(event) => void uploadPhoto(event.target.files?.[0])} />
            <span className="subtle">{photoStatus}</span>
          </div>
        </div>
      </section>
    </>
  );
}

function CvVersions() {
  const { data, loading, error, refresh } = useApi<CvVersion[]>("/api/cv", []);
  const template = useApi<CvVersion | null>("/api/cv/template", null);
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => data.find((version) => version.id === selectedId) ?? data[0], [data, selectedId]);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    if (!selectedId && data[0]) {
      setSelectedId(data[0].id);
    }
  }, [data, selectedId]);

  useEffect(() => {
    setDraft(selected ? stringifyCv(selected.json) : "");
  }, [selected?.id, selected?.json]);

  const saveVersion = async () => {
    if (!selected) return;
    setSaveState("Saving");
    try {
      const content = parseDraft(draft);
      await sendJson(`/api/cv/${selected.id}`, "PUT", { label: selected.label, source: selected.source ?? "editor", content });
      setSaveState("Saved");
      await refresh();
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : "Save failed");
    }
  };

  const setTemplate = async () => {
    if (!selected) return;
    setSaveState("Selecting template");
    try {
      await sendJson<CvVersion>("/api/cv/template", "PUT", { cvVersionId: selected.id });
      setSaveState("Template selected");
      await template.refresh();
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : "Template selection failed");
    }
  };

  const toggleEvidence = async (include: boolean) => {
    if (!selected) return;
    setSaveState(include ? "Including as evidence" : "Excluding from evidence");
    try {
      await sendJson(`/api/cv/${selected.id}/evidence`, "PUT", { include });
      setSaveState(include ? "Now used as evidence" : "Excluded from tailoring");
      await refresh();
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : "Update failed");
    }
  };

  const isTemplate = (version: CvVersion) => template.data?.id === version.id;
  const roleOf = (version: CvVersion): { label: string; state: string } =>
    isTemplate(version)
      ? { label: "Template", state: "online" }
      : version.includeEvidence === false
        ? { label: "Excluded", state: "offline" }
        : { label: "Evidence", state: "warning" };
  const selectedIsTemplate = selected ? isTemplate(selected) : false;

  return (
    <>
      <PageHeader title="CV Versions" description="One CV is the template (its design is used for your “My CV” output). Every other CV is evidence the AI draws on when tailoring." />
      <section className="status-strip">
        <StatusPill state={template.data ? "online" : "warning"} label={template.data ? "Template" : "Missing"} />
        <span>{template.data ? `“${template.data.label}” is the active template. Others are used as supporting evidence — toggle any off to exclude it from tailoring.` : "Select one uploaded CV as the template before preparing applications."}</span>
      </section>
      <section className="split">
        <div className="panel version-list">
          <div className="panel-header">
            <h2>Versions</h2>
            <span>{loading ? "Loading" : error ? "Offline" : `${data.length} total`}</span>
          </div>
          {data.length === 0 ? <p className="empty-state">No CV versions imported yet.</p> : null}
          {data.map((version) => {
            const role = roleOf(version);
            return (
              <button
                className={[
                  selected?.id === version.id ? "version-row active" : "version-row",
                  isTemplate(version) ? "template" : ""
                ].join(" ").trim()}
                key={version.id}
                onClick={() => setSelectedId(version.id)}
                type="button"
              >
                <div className="version-row-head">
                  <strong>{version.label}</strong>
                  <StatusPill state={role.state} label={role.label} />
                </div>
                <span>{version.source ?? "paste"} - v{version.version ?? "?"} - {formatDate(version.createdAt)}</span>
              </button>
            );
          })}
        </div>
        <div className="panel editor-panel">
          <div className="panel-header">
            <h2>{selected?.label ?? "No version selected"}</h2>
            <div className="button-group">
              <IconButton icon={FilePenLine} label="Use as Template" onClick={() => void setTemplate()} disabled={!selected || selectedIsTemplate} />
              <IconButton icon={Save} label="Save Draft" onClick={() => void saveVersion()} disabled={!selected} />
            </div>
          </div>
          {selected ? (
            <div className="role-bar">
              {selectedIsTemplate ? (
                <p className="format-hint">This is your <strong>active template</strong>. Its content and design are the base for tailored CVs.</p>
              ) : (
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={selected.includeEvidence !== false}
                    onChange={(event) => void toggleEvidence(event.target.checked)}
                  />
                  <span>Use this CV as <strong>evidence</strong> when tailoring (the AI pulls in relevant facts from it)</span>
                </label>
              )}
            </div>
          ) : null}
          <textarea onChange={(event) => setDraft(event.target.value)} spellCheck={false} value={draft} />
          <span className="subtle">{saveState}</span>
        </div>
      </section>
    </>
  );
}

function AuditLog() {
  const { data, loading, error, refresh } = useApi<AuditEvent[]>("/api/audit", fallbackAudit);

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Inspect local automation events and backend decisions."
        action={<IconButton icon={RefreshCw} label="Reload" onClick={() => void refresh()} primary />}
      />
      <section className="panel">
        <div className="panel-header">
          <h2>Events</h2>
          <span>{loading ? "Loading" : error ? `Fallback view: ${error}` : `${data.length} records`}</span>
        </div>
        <div className="audit-table" role="table" aria-label="Audit log">
          <div className="audit-row header" role="row">
            <span>Time</span>
            <span>Action</span>
            <span>Entity</span>
            <span>Summary</span>
          </div>
          {data.map((entry) => (
            <div className="audit-row" role="row" key={entry.id}>
              <span>{formatDate(entry.createdAt)}</span>
              <span>{entry.action}</span>
              <span>{entry.entity ?? "system"}</span>
              <span>{entry.summary}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ModelSelect({
  models,
  purpose,
  value,
  onChange
}: {
  models: OpenRouterModel[];
  purpose: ModelPurpose;
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.id === value);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const q = query.trim().toLowerCase();
  // With a query, search across ALL models; with none, suggest role-relevant ones.
  const base = q ? models : models.filter((model) => matchesPurpose(model, purpose));
  const filtered = base
    .filter((model) => !q || [model.id, model.name, model.category].some((field) => field.toLowerCase().includes(q)))
    .sort((left, right) => compareModels(left, right, purpose))
    .slice(0, 80);

  const pick = (id: string) => { onChange(id); setQuery(""); setOpen(false); };

  return (
    <div className={open ? "model-combo open" : "model-combo"} ref={wrapRef}>
      <input
        className="model-combo-input"
        type="text"
        value={open ? query : (selected ? selected.name : value)}
        placeholder={selected ? selected.name : "Search models by name…"}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter" && filtered[0]) { event.preventDefault(); pick(filtered[0].id); }
        }}
      />
      <span className="model-combo-caret" aria-hidden>⌄</span>
      {open ? (
        <div className="model-combo-list">
          {filtered.length === 0 ? <div className="model-combo-empty">No models match “{query}”.</div> : null}
          {filtered.map((model) => (
            <button
              type="button"
              key={model.id}
              className={model.id === value ? "model-combo-option selected" : "model-combo-option"}
              onMouseDown={(event) => { event.preventDefault(); pick(model.id); }}
            >
              <span className="mco-name">{model.name}</span>
              <span className="mco-id">{model.id}{model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k` : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  primary,
  submit,
  disabled
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  primary?: boolean;
  submit?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={primary ? "button primary icon-button" : "button icon-button"}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type={submit ? "submit" : "button"}
    >
      <Icon size={17} />
      <span>{label}</span>
    </button>
  );
}

function StatusPill({ state, label }: { state: string; label: string }) {
  return <span className={`status-pill ${state}`}>{label}</span>;
}

function stringifyCv(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const rawText = (value as { rawText?: unknown }).rawText;
    if (typeof rawText === "string" && rawText.trim()) {
      return rawText;
    }
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "document";
}

function parseDraft(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}


function chooseModel(models: OpenRouterModel[], purpose: ModelPurpose) {
  const filtered = models.filter((model) => matchesPurpose(model, purpose));
  const ranked = filtered.length ? filtered : models;
  return ranked.slice().sort((left, right) => compareModels(left, right, purpose))[0];
}

function matchesPurpose(model: OpenRouterModel, purpose: ModelPurpose) {
  if (purpose === "search" || purpose === "review") {
    // Cheap/fast models for search and for the reviewer step.
    return model.category === "search" || model.category === "general" || /grok|fast|flash|mini|nano|haiku|lite/i.test(model.id);
  }
  if (purpose === "tailor" || purpose === "apply") {
    return model.category === "tailor" || model.category === "apply" || /claude/i.test(model.id);
  }
  return true;
}

function compareModels(left: OpenRouterModel, right: OpenRouterModel, purpose: ModelPurpose) {
  if (purpose === "search" || purpose === "review") {
    return scoreSearch(left) - scoreSearch(right);
  }
  return scoreTailor(left) - scoreTailor(right);
}

function scoreSearch(model: OpenRouterModel) {
  const prompt = Number(model.promptPrice ?? "1");
  const completion = Number(model.completionPrice ?? "1");
  const fastBonus = /grok|fast|flash|mini|nano|haiku|lite/i.test(model.id) ? -1 : 0;
  return (Number.isFinite(prompt) ? prompt : 1) + (Number.isFinite(completion) ? completion : 1) + fastBonus;
}

function scoreTailor(model: OpenRouterModel) {
  const lower = model.id.toLowerCase();
  if (lower === "anthropic/claude-sonnet-4.5") return -10;
  if (lower.includes("claude") && lower.includes("sonnet")) return -8;
  if (lower.includes("claude")) return -6;
  if (lower.includes("gpt-5.5") || lower.includes("gpt-5")) return -4;
  if (lower.includes("gemini")) return -2;
  return 0;
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
