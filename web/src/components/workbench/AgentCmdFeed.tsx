import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/apiFetch";

interface PendingApproval {
  run_id: string;
  approval_id: string;
  mirror_token: string;
  command: string;
  verdict: string;
}

interface CmdStreamEvent {
  t: "ready" | "cmd_start" | "cmd_chunk" | "cmd_exit" | "approval_pending" | "approval_cleared";
  run_id?: string;
  tool?: string;
  command?: string;
  cwd?: string;
  data?: string;
  code?: number | null;
  duration_ms?: number | null;
  output_bounded?: string;
  approval_id?: string;
  mirror_token?: string;
  verdict?: string;
}

function readHermesTerminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--bg").trim() || "#0d1015";
  const fg = cs.getPropertyValue("--text").trim() || "#e2e8f0";
  const accent = cs.getPropertyValue("--accent").trim() || "#10b981";
  const surface = cs.getPropertyValue("--surface").trim() || "#12151c";
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    selectionBackground: "rgba(16, 185, 129, 0.28)",
    black: surface,
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#22d3ee",
    white: fg,
  };
}

export function AgentCmdFeed({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connected, setConnected] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sessionId) return;

    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 8000,
      theme: readHermesTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();
    termRef.current = term;

    term.writeln("\x1b[90m# Live agent command feed attached. Waiting for commands…\x1b[0m");

    const streamedRuns = new Set<string>();
    const es = new EventSource(
      `/api/cockpit/cmd/stream?session_id=${encodeURIComponent(sessionId)}`,
      { withCredentials: true }
    );

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener("cmd", (rawEv) => {
      try {
        const ev = JSON.parse((rawEv as MessageEvent).data) as CmdStreamEvent;
        if (ev.t === "ready") {
          setConnected(true);
          return;
        }
        if (ev.t === "cmd_start") {
          const cwdSuffix = ev.cwd ? ` \x1b[90m(${ev.cwd})\x1b[0m` : "";
          term.write(`\r\n\x1b[1;36m$ ${ev.command || ev.tool || "cmd"}\x1b[0m${cwdSuffix}\r\n`);
          return;
        }
        if (ev.t === "cmd_chunk" && ev.data) {
          if (ev.run_id) streamedRuns.add(ev.run_id);
          term.write(ev.data);
          return;
        }
        if (ev.t === "cmd_exit") {
          const alreadyStreamed = Boolean(ev.run_id && streamedRuns.has(ev.run_id));
          if (!alreadyStreamed && ev.output_bounded) {
            term.write(ev.output_bounded);
            if (!ev.output_bounded.endsWith("\n")) term.write("\r\n");
          }
          const code = ev.code;
          const color = code === 0 || code === null || code === undefined ? "32" : "31";
          const codeLabel = code === null || code === undefined ? "done" : `exit ${code}`;
          const durLabel = ev.duration_ms != null ? ` · ${ev.duration_ms}ms` : "";
          term.write(`\x1b[${color}m[${codeLabel}${durLabel}]\x1b[0m\r\n`);
          return;
        }
        if (ev.t === "approval_pending") {
          setPendingApproval({
            run_id: ev.run_id || "",
            approval_id: ev.approval_id || "",
            mirror_token: ev.mirror_token || "",
            command: ev.command || "",
            verdict: ev.verdict || "Approval required",
          });
          return;
        }
        if (ev.t === "approval_cleared") {
          setPendingApproval(null);
        }
      } catch {
        // ignore malformed event
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(el);

    const themeObs = new MutationObserver(() => {
      term.options.theme = readHermesTerminalTheme();
    });
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-skin"],
    });

    return () => {
      themeObs.disconnect();
      ro.disconnect();
      es.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  const settleApproval = async (choice: "once" | "session" | "deny") => {
    if (!pendingApproval) return;
    setSettling(true);
    try {
      const body: Record<string, string> = {
        session_id: sessionId,
        choice,
      };
      if (pendingApproval.approval_id) body.approval_id = pendingApproval.approval_id;
      if (pendingApproval.run_id) body.run_id = pendingApproval.run_id;
      if (pendingApproval.mirror_token) body.mirror_token = pendingApproval.mirror_token;

      await apiFetch("/api/approval/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setPendingApproval(null);
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 bg-[var(--oh-canvas)] text-[var(--oh-text)]">
      {pendingApproval && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-amber-300">
                Approval required · {pendingApproval.verdict}
              </div>
              <pre className="mt-1 overflow-x-auto rounded border border-amber-500/20 bg-[var(--oh-canvas)] px-2 py-1 font-mono text-[11px] text-[var(--oh-text)] m-0">
                {pendingApproval.command}
              </pre>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={settling}
                  onClick={() => void settleApproval("once")}
                  className="rounded border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/30 cursor-pointer disabled:opacity-40"
                >
                  Approve Once
                </button>
                <button
                  type="button"
                  disabled={settling}
                  onClick={() => void settleApproval("session")}
                  className="rounded border border-blue-500/40 bg-blue-500/20 px-2.5 py-1 text-[11px] font-medium text-blue-300 hover:bg-blue-500/30 cursor-pointer disabled:opacity-40"
                >
                  Allow Session
                </button>
                <button
                  type="button"
                  disabled={settling}
                  onClick={() => void settleApproval("deny")}
                  className="rounded border border-red-500/40 bg-red-500/20 px-2.5 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/30 cursor-pointer disabled:opacity-40"
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 p-2 overflow-hidden" />

      <div className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--oh-border)] bg-[var(--oh-surface)] px-3 text-[10px] text-[var(--oh-muted)]">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${
              connected ? "bg-emerald-400" : "bg-zinc-500"
            }`}
          />
          {connected ? "Agent Feed · Live SSE" : "Connecting…"}
        </span>
        <button
          type="button"
          onClick={() => termRef.current?.clear()}
          className="font-mono text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
