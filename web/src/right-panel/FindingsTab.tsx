import { ArrowLeft, Check, Copy, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  const [selectedFinding, setSelectedFinding] = useState<HuntFinding | null>(null);
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
    setSelectedFinding(null);
  }, [defaultProgram]);

  const loadFindings = useCallback(() => {
    void apiFetch<{ findings?: HuntFinding[] }>(
      `/api/cockpit/findings?program=${encodeURIComponent(program)}`
    )
      .then((res) => {
        const list = res?.findings ?? [];
        setFindings(list);
        setSelectedFinding((prev) =>
          prev ? list.find((item) => item.id === prev.id) ?? null : null
        );
      })
      .catch(() => {
        setFindings([]);
        setSelectedFinding(null);
      });
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
    if (selectedFinding?.id === id) {
      setSelectedFinding(null);
    }
    loadFindings();
  };

  const buildReportMarkdown = (f: HuntFinding) => {
    const metaLines = [
      `**Severity:** ${f.severity.toUpperCase()}`,
      `**Status:** ${f.status}`,
      f.cwe ? `**CWE:** ${f.cwe}` : "",
      f.target_url ? `**Target:** \`${f.target_url}\`` : "",
      f.parameter ? `**Parameter:** \`${f.parameter}\`` : "",
      f.poc_path ? `**PoC:** \`${f.poc_path}\`` : "",
    ].filter(Boolean);

    return [
      `# ${f.title}`,
      "",
      metaLines.join(" · "),
      "",
      "## Steps to Reproduce",
      "",
      f.steps_to_reproduce || "_TBD_",
      "",
      "## Impact",
      "",
      f.impact || "_TBD_",
    ].join("\n");
  };

  const copyMarkdown = (f: HuntFinding) => {
    void navigator.clipboard?.writeText(buildReportMarkdown(f));
    setCopiedId(f.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  if (selectedFinding) {
    return (
      <div className="flex flex-1 flex-col min-h-0 bg-[var(--oh-canvas)]">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setSelectedFinding(null)}
              title="Back to findings"
              aria-label="Back to findings"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--oh-muted)] hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)] cursor-pointer transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                SEVERITY_COLORS[selectedFinding.severity]
              }`}
            >
              {selectedFinding.severity}
            </span>
            <span className="truncate font-mono text-[11px] text-[var(--oh-muted)]">
              {selectedFinding.id}.md
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => copyMarkdown(selectedFinding)}
              title="Copy HackerOne Markdown report"
              className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2 py-0.5 text-[10px] text-[var(--oh-text)] cursor-pointer"
            >
              {copiedId === selectedFinding.id ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>Copy Report</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(selectedFinding.id)}
              title="Delete finding"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--oh-muted)] hover:text-red-400 cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-xs leading-relaxed text-[var(--oh-text)]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="mb-3 text-base font-semibold text-[var(--oh-text)] border-b border-[var(--oh-border)] pb-2">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--oh-muted)]">
                  {children}
                </h2>
              ),
              p: ({ children }) => (
                <p className="mb-2.5 text-xs leading-relaxed text-[var(--oh-text)]">
                  {children}
                </p>
              ),
              ul: ({ children }) => (
                <ul className="mb-3 list-disc pl-5 space-y-1 text-xs">{children}</ul>
              ),
              ol: ({ children }) => (
                <ol className="mb-3 list-decimal pl-5 space-y-1 text-xs">{children}</ol>
              ),
              code: ({ children }) => (
                <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">
                  {children}
                </code>
              ),
              pre: ({ children }) => (
                <pre className="mb-3 overflow-x-auto rounded-md border border-[var(--oh-border)] bg-[var(--oh-surface)] p-2.5 font-mono text-[11px]">
                  {children}
                </pre>
              ),
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 underline hover:text-emerald-300"
                >
                  {children}
                </a>
              ),
            }}
          >
            {buildReportMarkdown(selectedFinding)}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

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
              role="button"
              tabIndex={0}
              onClick={() => setSelectedFinding(f)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedFinding(f);
                }
              }}
              className="rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)] p-3 space-y-1.5 cursor-pointer hover:border-emerald-500/40 transition-colors"
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
                    onClick={(e) => {
                      e.stopPropagation();
                      copyMarkdown(f);
                    }}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(f.id);
                    }}
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
