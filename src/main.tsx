import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ClipboardList,
  FilePenLine,
  FileUp,
  Gauge,
  History,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./styles.css";

type View = "dashboard" | "search" | "settings" | "base-cv" | "versions" | "audit";
type AutonomyLevel = "L0" | "L1" | "L2";
type ApiState<T> = { data: T; loading: boolean; error: string | null };

type DashboardSummary = {
  counts: {
    jobs: number;
    cvVersions: number;
    docSets: number;
    runs: number;
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
  applyModel?: string;
  generalModel?: string;
  openrouterApiKeySet?: boolean;
  tavilyApiKeySet?: boolean;
};

type CvVersion = {
  id: string;
  label: string;
  source?: string | null;
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
  counts: { jobs: 0, cvVersions: 0, docSets: 0, runs: 0 },
  auditEvents: [],
  policies: []
};

const emptySettings: SettingsPayload = {
  openrouterApiKey: "",
  tavilyApiKey: "",
  defaultCity: "",
  defaultAutonomyLevel: "L1",
  searchModel: "",
  tailorModel: "anthropic/claude-sonnet-4.5",
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
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

function App() {
  const [activeView, setActiveView] = useState<View>("dashboard");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AJ</div>
          <div>
            <strong>Automate Job Apply</strong>
            <span>M1 Operations</span>
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
        {activeView === "search" && <JobSearch />}
        {activeView === "settings" && <SettingsPage />}
        {activeView === "base-cv" && <BaseCvImport />}
        {activeView === "versions" && <CvVersions />}
        {activeView === "audit" && <AuditLog />}
      </main>
    </div>
  );
}

function JobSearch() {
  const settings = useApi<SettingsPayload>("/api/settings", emptySettings);
  const jobs = useApi<Job[]>("/api/jobs", []);
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [maxResults, setMaxResults] = useState(10);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!city && settings.data.defaultCity) {
      setCity(settings.data.defaultCity);
    }
  }, [settings.data.defaultCity, city]);

  const searchJobs = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus("Searching Tavily and ranking jobs");
    try {
      const response = await sendJson<{ jobs: Job[] }>("/api/jobs/search", "POST", { role, city, maxResults });
      setStatus(`Found ${response.jobs.length} jobs`);
      await jobs.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Search failed");
    }
  };

  return (
    <>
      <PageHeader
        title="Job Search"
        description="Search Tavily for jobs, store matches locally, and rank them against the latest CV."
        action={<IconButton icon={RefreshCw} label="Refresh Jobs" onClick={() => void jobs.refresh()} primary />}
      />
      <form className="panel search-form" onSubmit={(event) => void searchJobs(event)}>
        <Field label="Role">
          <input
            onChange={(event) => setRole(event.target.value)}
            placeholder="Frontend Engineer"
            type="text"
            value={role}
          />
        </Field>
        <Field label="City">
          <input
            onChange={(event) => setCity(event.target.value)}
            placeholder="Vienna"
            type="text"
            value={city}
          />
        </Field>
        <Field label="Max Results">
          <input
            max={20}
            min={1}
            onChange={(event) => setMaxResults(Number(event.target.value))}
            type="number"
            value={maxResults}
          />
        </Field>
        <div className="form-footer">
          <span>{status || "Uses Tavily for search and your configured search model for ranking."}</span>
          <IconButton icon={Search} label="Search Jobs" primary submit disabled={!role.trim() || !city.trim()} />
        </div>
      </form>
      <section className="panel">
        <div className="panel-header">
          <h2>Ranked Jobs</h2>
          <span>{jobs.loading ? "Loading" : jobs.error ? `Offline: ${jobs.error}` : `${jobs.data.length} saved`}</span>
        </div>
        {jobs.data.length === 0 ? <p className="empty-state">No jobs yet. Run a search after saving your Tavily key.</p> : null}
        <div className="job-list">
          {jobs.data.map((job) => (
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
              <a className="button job-link" href={job.url} rel="noreferrer" target="_blank">Open Posting</a>
            </article>
          ))}
        </div>
      </section>
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
  const [modelQuery, setModelQuery] = useState("");
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

  return (
    <>
      <PageHeader title="Settings" description="Configure OpenRouter, Tavily, model routing, autonomy level, and search defaults." />
      <form className="panel form-grid" onSubmit={(event) => void saveSettings(event)}>
        <div className="form-section">
          <h2>API Keys</h2>
          <p>Keys are stored encrypted on this computer and are not returned to the browser after saving.</p>
        </div>
        <Field label={`OpenRouter API Key${data.openrouterApiKeySet ? " - saved" : ""}`}>
          <input
            autoComplete="off"
            onChange={(event) => setForm({ ...form, openrouterApiKey: event.target.value })}
            placeholder="Leave blank to keep current key"
            type="password"
            value={form.openrouterApiKey ?? ""}
          />
        </Field>
        <Field label={`Tavily API Key${data.tavilyApiKeySet ? " - saved" : ""}`}>
          <input
            autoComplete="off"
            onChange={(event) => setForm({ ...form, tavilyApiKey: event.target.value })}
            placeholder="Leave blank to keep current key"
            type="password"
            value={form.tavilyApiKey ?? ""}
          />
        </Field>
        <div className="form-section">
          <h2>Model Routing</h2>
          <p>Recommended: fast OpenRouter models for search, Claude for tailoring and apply steps.</p>
        </div>
        <label className="field">
          <span>Filter Models</span>
          <input
            onChange={(event) => setModelQuery(event.target.value)}
            placeholder="grok fast, claude, flash..."
            type="text"
            value={modelQuery}
          />
        </label>
        <Field label="Search Model">
          <ModelSelect
            filter={modelQuery}
            models={openRouterModels}
            purpose="search"
            value={form.searchModel ?? ""}
            onChange={(value) => setForm({ ...form, searchModel: value })}
          />
        </Field>
        <Field label="Tailor Model">
          <ModelSelect
            filter={modelQuery}
            models={openRouterModels}
            purpose="tailor"
            value={form.tailorModel ?? ""}
            onChange={(value) => setForm({ ...form, tailorModel: value })}
          />
        </Field>
        <Field label="Apply Model">
          <ModelSelect
            filter={modelQuery}
            models={openRouterModels}
            purpose="apply"
            value={form.applyModel ?? ""}
            onChange={(value) => setForm({ ...form, applyModel: value })}
          />
        </Field>
        <Field label="General Model">
          <ModelSelect
            filter={modelQuery}
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

  const importFolder = async () => {
    if (!folderFiles.length) return;
    setStatus("Importing folder");
    try {
      const files = await Promise.all(
        folderFiles.map(async (file) => ({
          name: file.name,
          type: file.type,
          contentBase64: await fileToBase64(file)
        }))
      );
      await sendJson("/api/cv/import-files", "POST", {
        label: label.trim(),
        files
      });
      setStatus(`Imported ${files.length} files from folder`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Folder import failed");
    }
  };

  return (
    <>
      <PageHeader title="Base CV Import" description="Paste the source CV or import a local folder containing your resume files." />
      <form className="panel import-panel" onSubmit={(event) => void importCv(event)}>
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
          placeholder={mode === "json" ? "{ \"summary\": \"...\", \"experience\": [] }" : "Paste CV text here"}
          spellCheck={false}
          value={content}
        />
        <div className="folder-import">
          <div>
            <strong>Folder import</strong>
            <p>Choose a folder that contains your CV or resume files. PDF, DOCX, JSON, TXT, and MD files are supported.</p>
          </div>
          <input
            multiple
            onChange={(event) => setFolderFiles(Array.from(event.target.files ?? []))}
            type="file"
            webkitdirectory="true"
          />
          <button className="button" onClick={() => void importFolder()} type="button" disabled={!folderFiles.length}>
            Import Folder
          </button>
        </div>
        <div className="form-footer">
          <span>{status}</span>
          <IconButton icon={FileUp} label="Import Base CV" primary submit disabled={!content.trim() || !label.trim()} />
        </div>
      </form>
    </>
  );
}

function CvVersions() {
  const { data, loading, error, refresh } = useApi<CvVersion[]>("/api/cv", []);
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

  return (
    <>
      <PageHeader title="CV Versions" description="Review and edit generated CV variants before application runs." />
      <section className="split">
        <div className="panel version-list">
          <div className="panel-header">
            <h2>Versions</h2>
            <span>{loading ? "Loading" : error ? "Offline" : `${data.length} total`}</span>
          </div>
          {data.length === 0 ? <p className="empty-state">No CV versions imported yet.</p> : null}
          {data.map((version) => (
            <button
              className={selected?.id === version.id ? "version-row active" : "version-row"}
              key={version.id}
              onClick={() => setSelectedId(version.id)}
              type="button"
            >
              <strong>{version.label}</strong>
              <span>{version.source ?? "paste"} - {formatDate(version.createdAt)}</span>
            </button>
          ))}
        </div>
        <div className="panel editor-panel">
          <div className="panel-header">
            <h2>{selected?.label ?? "No version selected"}</h2>
            <IconButton icon={Save} label="Save Draft" onClick={() => void saveVersion()} disabled={!selected} />
          </div>
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
  filter,
  models,
  purpose,
  value,
  onChange
}: {
  filter: string;
  models: OpenRouterModel[];
  purpose: "search" | "tailor" | "apply" | "general";
  value: string;
  onChange: (value: string) => void;
}) {
  const filtered = models
    .filter((model) => matchesPurpose(model, purpose))
    .filter((model) => {
      const query = filter.trim().toLowerCase();
      if (!query) return true;
      return [model.id, model.name, model.category].some((value) => value.toLowerCase().includes(query));
    })
    .sort((left, right) => compareModels(left, right, purpose));

  const options = filtered.length ? filtered : models;

  return (
    <select onChange={(event) => onChange(event.target.value)} value={value || chooseModel(options, purpose)?.id || ""}>
      {options.map((model) => (
        <option key={model.id} value={model.id}>
          {modelLabel(model)}
        </option>
      ))}
    </select>
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
  return JSON.stringify(value ?? {}, null, 2);
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

function modelLabel(model: OpenRouterModel) {
  const context = model.contextLength ? ` - ${Math.round(model.contextLength / 1000)}k ctx` : "";
  const price = model.promptPrice ? ` - ${model.promptPrice} prompt` : "";
  return `${model.name} (${model.id})${context}${price}`;
}

function chooseModel(models: OpenRouterModel[], purpose: "search" | "tailor" | "apply" | "general") {
  const filtered = models.filter((model) => matchesPurpose(model, purpose));
  const ranked = filtered.length ? filtered : models;
  return ranked.slice().sort((left, right) => compareModels(left, right, purpose))[0];
}

function matchesPurpose(model: OpenRouterModel, purpose: "search" | "tailor" | "apply" | "general") {
  if (purpose === "search") {
    return model.category === "search" || model.category === "general";
  }
  if (purpose === "tailor" || purpose === "apply") {
    return model.category === "tailor" || model.category === "apply" || /claude/i.test(model.id);
  }
  return true;
}

function compareModels(left: OpenRouterModel, right: OpenRouterModel, purpose: "search" | "tailor" | "apply" | "general") {
  if (purpose === "search") {
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
