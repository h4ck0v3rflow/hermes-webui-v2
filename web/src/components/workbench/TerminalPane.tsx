import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { AgentCmdFeed } from "./AgentCmdFeed";

const ACCESSORY_KEYS: Array<{ label: string; seq: string; danger?: boolean }> = [
  { label: "Ctrl+C", seq: "\x03", danger: true },
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "|", seq: "|" },
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
];

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

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const [mode, setMode] = useState<"feed" | "shell">("feed");

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 bg-[var(--oh-canvas)] text-[var(--oh-text)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-2.5 gap-2">
        <div className="inline-flex items-center rounded-md border border-[var(--oh-border)] bg-[var(--oh-canvas)] p-0.5">
          <button
            type="button"
            onClick={() => setMode("feed")}
            className={`rounded px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-colors ${
              mode === "feed"
                ? "bg-[var(--oh-elevated)] text-[var(--oh-text)]"
                : "text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
            }`}
          >
            Agent Feed
          </button>
          <button
            type="button"
            onClick={() => setMode("shell")}
            className={`rounded px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-colors ${
              mode === "shell"
                ? "bg-[var(--oh-elevated)] text-[var(--oh-text)]"
                : "text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
            }`}
          >
            Shell
          </button>
        </div>
        <span className="font-mono text-[10px] text-[var(--oh-muted)] truncate">
          {mode === "feed" ? "Live commands & approvals" : "Interactive PTY"}
        </span>
      </div>

      {mode === "feed" ? (
        <AgentCmdFeed sessionId={sessionId} />
      ) : (
        <InteractiveShellPane sessionId={sessionId} />
      )}
    </div>
  );
}

function InteractiveShellPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  const status = useTerminalStore(
    (s) => s.statusBySession[sessionId] ?? "idle"
  );
  const error = useTerminalStore((s) => s.errorBySession[sessionId] ?? null);
  const workspace = useTerminalStore(
    (s) => s.workspaceBySession[sessionId] ?? ""
  );
  const startTerminal = useTerminalStore((s) => s.startTerminal);
  const sendInput = useTerminalStore((s) => s.sendInput);
  const resizeTerminal = useTerminalStore((s) => s.resizeTerminal);
  const setStatus = useTerminalStore((s) => s.setStatus);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sessionId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 5000,
      theme: readHermesTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();
    termRef.current = term;

    let es: EventSource | null = null;
    let disposed = false;

    const dataSub = term.onData((data) => {
      void sendInput(sessionId, data);
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fitAddon.fit();
        void resizeTerminal(sessionId, term.cols, term.rows);
      } catch {
        // ignore resize before layout settles
      }
    });
    ro.observe(el);

    void startTerminal(sessionId, term.cols || 80, term.rows || 24).then(
      (ok) => {
        if (disposed || !ok) return;
        es = new EventSource(
          `/api/terminal/output?session_id=${encodeURIComponent(sessionId)}`,
          { withCredentials: true }
        );
        es.addEventListener("output", (ev) => {
          try {
            const payload = JSON.parse((ev as MessageEvent).data) as {
              text?: string;
            };
            if (payload?.text) term.write(payload.text);
          } catch {
            // ignore malformed frame
          }
        });
        es.addEventListener("terminal_error", (ev) => {
          try {
            const payload = JSON.parse((ev as MessageEvent).data) as {
              error?: string;
            };
            setStatus(sessionId, "error", payload?.error ?? "Terminal error");
          } catch {
            setStatus(sessionId, "error", "Terminal error");
          }
        });
        es.addEventListener("terminal_closed", () => {
          setStatus(sessionId, "closed");
          es?.close();
        });
      }
    );

    return () => {
      disposed = true;
      dataSub.dispose();
      ro.disconnect();
      es?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, startTerminal, sendInput, resizeTerminal, setStatus]);

  return (
    <div className="flex flex-1 flex-col bg-[var(--oh-canvas)] min-h-0">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-3 gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="truncate font-mono text-[11px] text-[var(--oh-muted)]">
            {workspace || "pty-session"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-[7px] border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--oh-text)] shrink-0">
            <span
              className={`size-1.5 rounded-full ${
                status === "live"
                  ? "bg-emerald-400"
                  : status === "connecting"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-red-400"
              }`}
            />
            {status === "live"
              ? "PTY Live"
              : status === "connecting"
              ? "Connecting"
              : status === "closed"
              ? "Closed"
              : "Offline"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            className="rounded-[7px] border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--oh-text)] hover:bg-white/10 cursor-pointer"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void sendInput(sessionId, "\x03")}
            className="rounded-[7px] border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--oh-text)] hover:bg-white/10 cursor-pointer"
          >
            Ctrl+C
          </button>
          <button
            type="button"
            onClick={() => {
              const t = termRef.current;
              void startTerminal(sessionId, t?.cols || 80, t?.rows || 24, true);
            }}
            className="rounded-[7px] border border-[var(--oh-border)] bg-[var(--oh-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
          >
            Restart
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-500/30 bg-[var(--oh-elevated)] px-3 py-1.5 text-[11px] text-red-400">
          {error}
        </div>
      )}

      {/* xterm.js canvas */}
      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        className="flex-1 min-h-0 p-2 overflow-hidden"
      />

      {/* Mobile Sticky Terminal Accessory Bar (M2) */}
      <div className="flex lg:hidden shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border-subtle bg-surface px-2.5 py-2">
        {ACCESSORY_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            onClick={() => {
              void sendInput(sessionId, k.seq);
              termRef.current?.focus();
            }}
            className={`shrink-0 rounded-[7px] border border-border-subtle bg-elevated px-3 py-1.5 text-[11px] font-medium ${
              k.danger ? "text-[#e58e94]" : "text-text-primary"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Desktop footer */}
      <div className="hidden lg:flex h-6 shrink-0 items-center justify-between border-t border-[var(--oh-border)] bg-[var(--oh-surface)] px-3 text-[10px] text-[var(--oh-muted)]">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${
              status === "live" ? "bg-emerald-400" : "bg-zinc-500"
            }`}
          />
          {status === "live" ? "Connected · UTF-8" : `Status: ${status}`}
        </span>
        <span className="font-mono text-[var(--oh-muted)]">xterm.js PTY</span>
      </div>
    </div>
  );
}
