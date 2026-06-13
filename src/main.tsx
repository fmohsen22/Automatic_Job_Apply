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
  Settings as SettingsIcon
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./styles.css";

type View = "dashboard" | "settings" | "base-cv" | "versions" | "audit";
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
  openaiApiKey?: string;
  tavilyApiKey?: string;
  defaultCity?: string;
  defaultAutonomyLevel?: AutonomyLevel;
  defaultModel?: string;
  openaiApiKeySet?: boolean;
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

const autonomyLabels: Record<AutonomyLevel, string> = {
  L0: "Assist",
  L1: "Semi-auto",
  L2: "Full-auto"
};

const views: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
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
  openaiApiKey: "",
  tavilyApiKey: "",
  defaultCity: "",
  defaultAutonomyLevel: "L1",
  defaultModel: "gpt-4.1"
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
        {activeView === "settings" && <SettingsPage />}
        {activeView === "base-cv" && <BaseCvImport />}
        {activeView === "versions" && <CvVersions />}
        {activeView === "audit" && <AuditLog />}
      </main>
    </div>
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
  const [form, setForm] = useState<SettingsPayload>(emptySettings);
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    setForm({
      ...emptySettings,
      ...data,
      openaiApiKey: "",
      tavilyApiKey: ""
    });
  }, [data]);

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
      <PageHeader title="Settings" description="Configure API credentials, autonomy level, model, and search defaults." />
      <form className="panel form-grid" onSubmit={(event) => void saveSettings(event)}>
        <Field label={`OpenAI API Key${data.openaiApiKeySet ? " - saved" : ""}`}>
          <input
            autoComplete="off"
            onChange={(event) => setForm({ ...form, openaiApiKey: event.target.value })}
            placeholder="Leave blank to keep current key"
            type="password"
            value={form.openaiApiKey ?? ""}
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
        <Field label="Default Model">
          <input
            onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}
            placeholder="gpt-4.1"
            type="text"
            value={form.defaultModel ?? ""}
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

  return (
    <>
      <PageHeader title="Base CV Import" description="Paste the source CV as structured JSON or plain text." />
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
