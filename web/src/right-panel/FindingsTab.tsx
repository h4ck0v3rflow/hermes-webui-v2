import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiFetch";
import { usePanelBridgeStore } from "../stores/panelBridgeStore";

export interface HuntFinding {
  id: string;
  program: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  status: "draft" | "verified" | "submitted";
  target_url: string;
  parameter?: string;
  cwe?: string;
  poc_path?: string;
  steps_to_reproduce: string;
  impact: string;
  updated_at: string;
}

const SEVERITY_COLORS: Record<HuntFinding["severity"], string> = {
  critical: "bg-red-500/20 text-red-300 border-red-500/40",
  high: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  medium: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  low: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  info: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

export default function FindingsTab() {
  const defaultProgram = usePanelBridgeStore((s) => s.program || "default");
  const [program, setProgram] = useState(defaultProgram);
  const [findings, setFindings] = useState<HuntFinding[]>([]);
  const [adding, setAdding] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<HuntFinding["severity"]>("high");
  const [targetUrl, setTargetUrl] = useState("");
  const [cwe, setCwe] = useState("");
  const [steps, setSteps] = useState("");
  const [impact, setImpact] = useState("");

  useEffect(() => {
    setProgram(defaultProgram);
  }, [defaultProgram]);

  const loadFindings = useCallback(() => {
    void apiFetch<{ findings?: HuntFinding[] }>(
      `/api/cockpit/findings?program=${encodeURIComponent(program)}`
    )
      .then((res) => setFindings(res?.findings ?? []))
      .catch(() => setFindings([]));
  }, [program]);

  useEffect(() => {
    loadFindings();
  }, [loadFindings]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await apiFetch("/api/cockpit/findings", {
      method: "POST",
      body: JSON.stringify({
        program,
        title,
        severity,
        status: "draft",
        target_url: targetUrl,
        cwe,
        steps_to_reproduce: steps,
        impact,
      }),
    });
    setTitle("");
    setTargetUrl("");
    setCwe("");
    setSteps("");
    setImpact("");
    setAdding(false);
    loadFindings();
  };

  const handleDelete = async (id: string) => {
    await apiFetch(
      `/api/cockpit/findings?program=${encodeURIComponent(
        program
      )}&id=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    loadFindings();
  };

  const copyMarkdown = (f: HuntFinding) => {
    const md = [
      `# ${f.title}`,
      `**Severity:** ${f.severity.toUpperCase()}${f.cwe ? ` · **CWE:** ${f.cwe}` : ""}`,
      f.target_url ? `**Target:** ${f.target_url}` : "",
      "",
      "## Steps to Reproduce",
      f.steps_to_reproduce || "_TBD_",
      "",
      "## Impact",
      f.impact || "_TBD_",
    ]
      .filter(Boolean)
      .join("\n");
    void navigator.clipboard?.writeText(md);
    setCopiedId(f.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-[var(--oh-canvas)]">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-medium text-[var(--oh-muted)]">
            Program:
          </span>
          <input
            type="text"
            value={program}
            onChange={(e) => setProgram(e.target.value || "default")}
            className="w-28 rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2 py-0.5 text-[11px] text-[var(--oh-text)] focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--oh-accent)] px-2.5 py-1 text-[11px] font-semibold text-[#062117] cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          <span>{adding ? "Cancel" : "New Finding"}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {adding && (
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)] p-3 space-y-2 text-xs"
          >
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Finding title (e.g. IDOR on /api/v2/users/{id})"
              className="w-full rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 py-1.5 text-[var(--oh-text)] focus:outline-none"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={severity}
                onChange={(e) =>
                  setSeverity(e.target.value as HuntFinding["severity"])
                }
                className="rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2 py-1 text-[var(--oh-text)]"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="info">Info</option>
              </select>
              <input
                type="text"
                value={cwe}
                onChange={(e) => setCwe(e.target.value)}
                placeholder="CWE-639"
                className="rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2 py-1 text-[var(--oh-text)] focus:outline-none"
              />
            </div>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://target.example/endpoint"
              className="w-full rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 py-1 text-[var(--oh-text)] focus:outline-none"
            />
            <textarea
              rows={3}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder="Steps to reproduce..."
              className="w-full rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 py-1.5 text-[var(--oh-text)] focus:outline-none"
            />
            <textarea
              rows={2}
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              placeholder="Security impact..."
              className="w-full rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 py-1.5 text-[var(--oh-text)] focus:outline-none"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-[var(--oh-accent)] py-1.5 font-semibold text-[#062117] cursor-pointer"
            >
              Save Finding (.md)
            </button>
          </form>
        )}

        {findings.length === 0 && !adding ? (
          <div className="py-12 text-center text-xs text-[var(--oh-muted)]">
            No findings recorded for <span className="font-mono">{program}</span>.
          </div>
        ) : (
          findings.map((f) => (
            <div
              key={f.id}
              className="rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)] p-3 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                      SEVERITY_COLORS[f.severity]
                    }`}
                  >
                    {f.severity}
                  </span>
                  {f.cwe && (
                    <span className="font-mono text-[10px] text-[var(--oh-muted)]">
                      {f.cwe}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyMarkdown(f)}
                    title="Copy HackerOne Markdown report"
                    className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2 py-0.5 text-[10px] text-[var(--oh-text)] cursor-pointer"
                  >
                    {copiedId === f.id ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Report</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(f.id)}
                    title="Delete finding"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--oh-muted)] hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <p className="text-xs font-medium text-[var(--oh-text)]">
                {f.title}
              </p>
              {f.target_url && (
                <p className="truncate font-mono text-[10px] text-[var(--oh-muted)]">
                  {f.target_url}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
