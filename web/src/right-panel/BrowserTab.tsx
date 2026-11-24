import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Hand,
  Maximize2,
  Minimize2,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiFetch";

interface BrowserHistoryEntry {
  url: string;
  title?: string;
  action?: string;
  screenshot_b64?: string;
  timestamp: number;
}

interface BrowserPageInfo {
  id?: string;
  page_id?: string;
  url?: string;
  title?: string;
  active?: boolean;
}

interface BrowserActivityEvent {
  t: "nav" | "dialog" | "popup" | "console";
  url?: string;
  message?: string;
  text?: string;
  ts: number;
}

interface BrowserControlState {
  paused: boolean;
  hosted_devtools_url: string;
  ssh_forward_command: string;
}

interface BrowserStatePayload {
  session_id: string;
  url: string;
  title?: string;
  last_action?: string;
  screenshot_b64: string;
  lease_holder: "AGENT" | "HUMAN";
  updated_at: number;
  history?: BrowserHistoryEntry[];
}

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatAge(ts: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

const DEVICE_PRESETS = {
  desktop: { w: 1280, h: 720, mobile: false },
  tablet: { w: 768, h: 1024, mobile: true },
  mobile: { w: 390, h: 844, mobile: true },
} as const;

export default function BrowserTab({
  sessionId,
  active = true,
}: {
  sessionId: string;
  /** False while another right-panel tab is showing: keeps the pane mounted (state
   * preserved, no reload) but closes the frame stream so a hidden tab costs nothing. */
  active?: boolean;
}) {
  const [state, setState] = useState<BrowserStatePayload>({
    session_id: sessionId,
    url: "",
    title: "",
    last_action: "",
    screenshot_b64: "",
    lease_holder: "AGENT",
    updated_at: 0,
    history: [],
  });
  const [hpMode, setHpMode] = useState<"connecting" | "huntproxy" | "offline">("connecting");
  const [hpBrowserActive, setHpBrowserActive] = useState(false);
  const [hpProjectId, setHpProjectId] = useState<number | null>(null);
  const [control, setControl] = useState<BrowserControlState>({
    paused: false,
    hosted_devtools_url: "",
    ssh_forward_command: "",
  });
  const [pages, setPages] = useState<BrowserPageInfo[]>([]);
  const [timeline, setTimeline] = useState<BrowserActivityEvent[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);
  const [copiedSsh, setCopiedSsh] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [selectedHistoryIdx, setSelectedHistoryIdx] = useState<number | null>(null);
  const [zoomFull, setZoomFull] = useState(false);
  const [switchingLease, setSwitchingLease] = useState(false);
  // Live interactive mode: CDP screencast down, real input events up. Only while the
  // human holds control — the agent's own view keeps using the snapshot path.
  const [liveFrame, setLiveFrame] = useState<{ b64: string; w: number; h: number; seq: number } | null>(null);
  const [liveStatus, setLiveStatus] = useState<"idle" | "ready" | "offline">("idle");
  // Device emulation presets: the site renders its OWN responsive layout at that
  // viewport instead of being CSS-scaled, which is what "fit" has to mean.
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">(() => {
    const saved = window.localStorage.getItem("cockpit.device");
    return saved === "tablet" || saved === "mobile" ? saved : "desktop";
  });
  const wheelRef = useRef<{ dx: number; dy: number; x: number; y: number; t: number }>({
    dx: 0,
    dy: 0,
    x: 0,
    y: 0,
    t: 0,
  });
  const liveEsRef = useRef<EventSource | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isEditingUrlRef = useRef(false);
  const liveMode = Boolean(control.paused) && hpProjectId !== null && hpBrowserActive;

  useEffect(() => {
    void apiFetch<BrowserStatePayload>(
      `/api/cockpit/browser/state?session_id=${encodeURIComponent(sessionId)}`
    )
      .then((res) => {
        if (res) {
          setState(res);
          if (res.url && !isEditingUrlRef.current) setUrlInput(res.url);
        }
      })
      .catch(() => {});

    if (!active || typeof EventSource === "undefined") return;
    const es = new EventSource(
      `/api/cockpit/browser/stream?session_id=${encodeURIComponent(sessionId)}`,
      { withCredentials: true }
    );

    const onLegacyState = (ev: Event) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as BrowserStatePayload;
        if (next) {
          setState(next);
          if (next.url && !isEditingUrlRef.current) setUrlInput(next.url);
          setSelectedHistoryIdx(null);
        }
      } catch {
        // ignore
      }
    };

    const onBrowserEvent = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
        const t = String(data.t || "");
        if (t === "ready") {
          setHpMode("huntproxy");
          if (typeof data.project_id === "number") setHpProjectId(data.project_id);
          return;
        }
        if (t === "offline") {
          setHpMode("offline");
          setHpBrowserActive(false);
          return;
        }
        if (t === "no_browser") {
          setHpMode("huntproxy");
          setHpBrowserActive(false);
          setControl((prev) => ({ ...prev, paused: false }));
          return;
        }
        if (t === "control") {
          setHpBrowserActive(true);
          const paused = Boolean(data.paused);
          setControl({
            paused,
            hosted_devtools_url: String(data.hosted_devtools_url || ""),
            ssh_forward_command: String(data.ssh_forward_command || ""),
          });
          setState((prev) => ({
            ...prev,
            lease_holder: paused ? "HUMAN" : "AGENT",
          }));
          return;
        }
        if (t === "pages" && Array.isArray(data.pages)) {
          setHpBrowserActive(true);
          setPages(data.pages as BrowserPageInfo[]);
          return;
        }
        if (t === "frame") {
          setHpBrowserActive(true);
          const jpeg = String(data.jpeg_b64 || "");
          const frameMime = String((data as { mime_type?: string }).mime_type || "image/png");
          const frameUrl = String(data.url || "");
          const ts = Number(data.ts || Date.now() / 1000);
          const dataUri = jpeg
            ? jpeg.startsWith("data:image/")
              ? jpeg
              : `data:${frameMime};base64,${jpeg}`
            : "";
          if (frameUrl && !isEditingUrlRef.current) setUrlInput(frameUrl);
          setSelectedHistoryIdx(null);
          setState((prev) => {
            const nextUrl = frameUrl || prev.url;
            const nextHist = [...(prev.history || [])];
            if (dataUri || nextUrl) {
              nextHist.push({
                url: nextUrl,
                action: "huntproxy",
                screenshot_b64: dataUri || prev.screenshot_b64,
                timestamp: ts,
              });
            }
            return {
              ...prev,
              url: nextUrl,
              screenshot_b64: dataUri || prev.screenshot_b64,
              last_action: "huntproxy",
              updated_at: ts,
              history: nextHist.slice(-12),
            };
          });
          return;
        }
        if (t === "nav" || t === "dialog" || t === "popup" || t === "console") {
          setTimeline((prev) => [
            ...prev.slice(-39),
            {
              t,
              url: data.url ? String(data.url) : undefined,
              message: data.message ? String(data.message) : undefined,
              text: data.text ? String(data.text) : undefined,
              ts: Number(data.ts || Date.now() / 1000),
            },
          ]);
        }
      } catch {
        // ignore
      }
    };

    es.addEventListener("browser_state", onLegacyState);
    es.addEventListener("browser", onBrowserEvent);
    return () => {
      es.close();
    };
  }, [sessionId, active]);

  const history = useMemo(() => state.history ?? [], [state.history]);
  const activeIdx =
    selectedHistoryIdx !== null && selectedHistoryIdx >= 0 && selectedHistoryIdx < history.length
      ? selectedHistoryIdx
      : history.length > 0
      ? history.length - 1
      : null;

  const activeEntry = activeIdx !== null ? history[activeIdx] : null;
  const displayUrl = activeEntry?.url || state.url || "";
  const displayShot = activeEntry?.screenshot_b64 || state.screenshot_b64 || "";
  const displayAction = activeEntry?.action || state.last_action || "";
  const displayTs = activeEntry?.timestamp || state.updated_at || 0;

  const hasPage = Boolean(displayShot);
  const imgSrc = displayShot
    ? displayShot.startsWith("data:image/")
      ? displayShot
      : `data:image/png;base64,${displayShot}`
    : "";

  const canGoBack = activeIdx !== null && activeIdx > 0;
  const canGoForward = activeIdx !== null && activeIdx < history.length - 1;
  const isHumanControl = control.paused || state.lease_holder === "HUMAN";

  // ---- live CDP screencast (human takeover) ----
  useEffect(() => {
    if (!active || !liveMode || hpProjectId === null || typeof EventSource === "undefined") {
      if (liveEsRef.current) {
        liveEsRef.current.close();
        liveEsRef.current = null;
      }
      setLiveStatus("idle");
      return;
    }
    const es = new EventSource(`/api/cockpit/browser/live?project_id=${hpProjectId}`, {
      withCredentials: true,
    });
    liveEsRef.current = es;
    const onEvent = (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data) as Record<string, unknown>;
        if (d.t === "ready") {
          setLiveStatus("ready");
        } else if (d.t === "offline") {
          setLiveStatus("offline");
        } else if (d.t === "frame" && typeof d.jpeg_b64 === "string") {
          setLiveStatus("ready");
          setLiveFrame({
            b64: d.jpeg_b64,
            w: Number(d.w) || 1280,
            h: Number(d.h) || 720,
            seq: Number(d.seq) || 0,
          });
        }
      } catch {
        // keepalive or malformed frame — ignore
      }
    };
    es.addEventListener("browser_live", onEvent as EventListener);
    es.onerror = () => setLiveStatus("offline");
    return () => {
      es.removeEventListener("browser_live", onEvent as EventListener);
      es.close();
      liveEsRef.current = null;
    };
  }, [active, liveMode, hpProjectId]);

  const sendInput = (payload: Record<string, unknown>) => {
    if (hpProjectId === null || !liveMode) return;
    void apiFetch("/api/cockpit/browser/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, project_id: hpProjectId, session_id: sessionId }),
    }).catch(() => undefined);
  };

  const framePoint = (e: { clientX: number; clientY: number }) => {
    const el = viewportRef.current;
    if (!el || !liveFrame) return null;
    const rect = el.getBoundingClientRect();
    const vw = liveFrame.w || 1280;
    const vh = liveFrame.h || 720;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    if (!scale) return null;
    const offX = rect.left + (rect.width - vw * scale) / 2;
    const offY = rect.top + (rect.height - vh * scale) / 2;
    const x = (e.clientX - offX) / scale;
    const y = (e.clientY - offY) / scale;
    if (x < 0 || y < 0 || x > vw || y > vh) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const handleViewportKey = (ev: {
    key: string;
    preventDefault: () => void;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) => {
    if (!liveMode) return;
    const modifiers =
      (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
    const special = [
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ];
    if (special.indexOf(ev.key) !== -1) {
      ev.preventDefault();
      sendInput({ kind: "key", key: ev.key, modifiers });
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      sendInput({ kind: "text", text: ev.key });
    }
  };

  // Apply the chosen viewport as soon as the live session is up, and on every change.
  useEffect(() => {
    if (!liveMode) return;
    const p = DEVICE_PRESETS[device];
    sendInput({ kind: "device", width: p.w, height: p.h, mobile: p.mobile });
    window.localStorage.setItem("cockpit.device", device);
  }, [device, liveMode]);

  // Wheel events fire ~60/s; forwarding each one buried the click behind hundreds of
  // POSTs, which is why a click took a minute to land. Coalesce to one flush per 60 ms.
  const flushWheel = (x: number, y: number, dx: number, dy: number) => {
    const b = wheelRef.current;
    b.dx += dx;
    b.dy += dy;
    b.x = x;
    b.y = y;
    if (b.t) return;
    b.t = window.setTimeout(() => {
      const c = wheelRef.current;
      sendInput({ kind: "wheel", x: c.x, y: c.y, deltaX: c.dx, deltaY: c.dy });
      c.dx = 0;
      c.dy = 0;
      c.t = 0;
    }, 60);
  };

  const toggleLease = async () => {
    setSwitchingLease(true);
    try {
      if (hpMode === "huntproxy") {
        const op = isHumanControl ? "disable" : "enable";
        const res = await apiFetch<{
          ok?: boolean;
          paused?: boolean;
          hosted_devtools_url?: string;
          ssh_forward_command?: string;
        }>("/api/cockpit/browser/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            project_id: hpProjectId,
            action: "cdp",
            op,
          }),
        });
        if (res?.ok) {
          const paused = Boolean(res.paused);
          setControl({
            paused,
            hosted_devtools_url: res.hosted_devtools_url || "",
            ssh_forward_command: res.ssh_forward_command || "",
          });
          setState((prev) => ({
            ...prev,
            lease_holder: paused ? "HUMAN" : "AGENT",
          }));
        }
        return;
      }

      const nextHolder = state.lease_holder === "AGENT" ? "HUMAN" : "AGENT";
      const res = await apiFetch<{ state?: BrowserStatePayload }>(
        "/api/cockpit/browser/lease",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, holder: nextHolder }),
        }
      );
      if (res?.state) setState(res.state);
    } finally {
      setSwitchingLease(false);
    }
  };

  const handleSubmitUrl = async (e: FormEvent) => {
    e.preventDefault();
    const target = normalizeUrlInput(urlInput);
    if (!target) return;
    setUrlInput(target);
    try {
      if (hpMode === "huntproxy") {
        await apiFetch("/api/cockpit/browser/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            project_id: hpProjectId,
            action: "navigate",
            url: target,
          }),
        });
        return;
      }
      const res = await apiFetch<{ state?: BrowserStatePayload }>(
        "/api/cockpit/browser/frame",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, url: target }),
        }
      );
      if (res?.state) setState(res.state);
    } catch {
      // ignore
    }
  };

  const handlePageOp = async (op: "select" | "open" | "close", pageId?: string) => {
    if (hpMode !== "huntproxy") return;
    try {
      await apiFetch("/api/cockpit/browser/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          project_id: hpProjectId,
          action: "pages",
          op,
          page_id: pageId,
        }),
      });
    } catch {
      // ignore
    }
  };

  const handleDownloadShot = () => {
    if (!imgSrc) return;
    const a = document.createElement("a");
    a.href = imgSrc;
    a.download = `browser-${shortHost(displayUrl) || "frame"}.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  };

  const handleCopySsh = () => {
    if (!control.ssh_forward_command) return;
    void navigator.clipboard?.writeText(control.ssh_forward_command);
    setCopiedSsh(true);
    setTimeout(() => setCopiedSsh(false), 1800);
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 bg-[var(--oh-canvas)]">
      {/* Top Browser Chrome */}
      <form
        onSubmit={(e) => void handleSubmitUrl(e)}
        className="flex shrink-0 items-center gap-1.5 border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-2.5 py-2"
      >
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            disabled={!canGoBack}
            onClick={() =>
              activeIdx !== null && setSelectedHistoryIdx(Math.max(0, activeIdx - 1))
            }
            title="Previous frame"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--oh-muted)] hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!canGoForward}
            onClick={() =>
              activeIdx !== null &&
              setSelectedHistoryIdx(Math.min(history.length - 1, activeIdx + 1))
            }
            title="Next frame"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--oh-muted)] hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed transition-colors"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Omnibox */}
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 focus-within:border-emerald-500/50 transition-colors">
          <Globe className="h-3 w-3 shrink-0 text-[var(--oh-muted)]" />
          <input
            type="text"
            value={urlInput}
            onFocus={() => {
              isEditingUrlRef.current = true;
            }}
            onBlur={() => {
              isEditingUrlRef.current = false;
            }}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL or wait for agent…"
            className="w-full min-w-0 bg-transparent text-[11px] font-mono text-[var(--oh-text)] placeholder:text-[var(--oh-muted)]"
          />
          {displayUrl && (
            <a
              href={displayUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {/* Take Control / Hand Back pill */}
        <button
          type="button"
          disabled={switchingLease || (hpMode === "huntproxy" && !hpBrowserActive)}
          onClick={() => void toggleLease()}
          title={
            hpMode === "huntproxy" && !hpBrowserActive
              ? "Waiting for agent to launch browser in bug hunting workflow"
              : isHumanControl
              ? "Hand control back to AGENT"
              : "Take Control (pauses agent browser actions)"
          }
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[10px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
            isHumanControl
              ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
              : "border-emerald-500/30 bg-[var(--oh-elevated)] text-[var(--oh-text)] hover:border-emerald-500/50"
          }`}
        >
          {isHumanControl ? (
            <>
              <Hand className="h-3 w-3" />
              <span>HUMAN</span>
            </>
          ) : (
            <>
              <Bot className="h-3 w-3 text-emerald-400" />
              <span>AGENT</span>
            </>
          )}
        </button>
      </form>

      {/* Agent Paused — Human in Control Banner (browser_cdp) */}
      {control.paused && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <Hand className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span>Agent paused — human in control</span>
          </div>
          <div className="flex items-center gap-1.5">
            {control.hosted_devtools_url && (
              <a
                href={control.hosted_devtools_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200 hover:bg-amber-500/25"
              >
                DevTools <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {control.ssh_forward_command && (
              <button
                type="button"
                onClick={handleCopySsh}
                className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/20 cursor-pointer"
              >
                <Copy className="h-2.5 w-2.5" />
                <span>{copiedSsh ? "Copied SSH" : "Copy SSH"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* HuntProxy Chromium Tab Strip (pages) */}
      {pages.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--oh-border)] bg-[var(--oh-surface)] px-2 py-1">
          {pages.map((p, idx) => {
            const pid = p.page_id || p.id || String(idx);
            const label = p.title || shortHost(p.url || "") || `Tab ${idx + 1}`;
            return (
              <div
                key={pid}
                className={`inline-flex max-w-[140px] shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] ${
                  p.active
                    ? "border-emerald-500/40 bg-[var(--oh-elevated)] text-[var(--oh-text)]"
                    : "border-[var(--oh-border)] bg-[var(--oh-canvas)] text-[var(--oh-muted)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handlePageOp("select", pid)}
                  className="truncate cursor-pointer"
                  title={p.url || label}
                >
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePageOp("close", pid)}
                  title="Close tab"
                  className="opacity-60 hover:opacity-100 cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => void handlePageOp("open")}
            title="New tab"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--oh-border)] text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Action / Status Strip */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2.5 py-1 text-[10px] text-[var(--oh-muted)]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              hpMode === "huntproxy"
                ? hpBrowserActive
                  ? "bg-emerald-400"
                  : "bg-amber-400"
                : "bg-zinc-500"
            }`}
          />
          <span className="font-mono truncate text-[var(--oh-text)]">
            {hpMode === "huntproxy"
              ? hpBrowserActive
                ? displayAction || `HuntProxy Chromium #${hpProjectId ?? ""}`
                : "No active browser — opens when agent uses browser"
              : hpMode === "offline"
              ? "HuntProxy offline (expected on PC dev)"
              : "Connecting…"}
          </span>
          {displayTs > 0 && <span className="shrink-0">· {formatAge(displayTs)}</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {liveMode && (
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value as "desktop" | "tablet" | "mobile")}
              title="Emulated viewport — the site renders its own responsive layout"
              className="cursor-pointer rounded border border-[var(--oh-border)] bg-[var(--oh-surface)] px-1 py-0.5 text-[10px] text-[var(--oh-text)]"
            >
              <option value="desktop">Desktop</option>
              <option value="tablet">Tablet</option>
              <option value="mobile">Mobile</option>
            </select>
          )}
          {timeline.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTimeline((s) => !s)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 cursor-pointer ${
                showTimeline
                  ? "bg-[var(--oh-elevated)] text-[var(--oh-text)]"
                  : "hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)]"
              }`}
            >
              <Activity className="h-3 w-3" />
              <span>{timeline.length}</span>
            </button>
          )}
          {hasPage && (
            <>
              <button
                type="button"
                onClick={() => setZoomFull((z) => !z)}
                title={zoomFull ? "Fit to panel" : "Actual size (100%)"}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)] cursor-pointer"
              >
                {zoomFull ? (
                  <Minimize2 className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
                <span>{zoomFull ? "Fit" : "100%"}</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadShot}
                title="Download screenshot"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--oh-elevated)] hover:text-[var(--oh-text)] cursor-pointer"
              >
                <Download className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Viewport — live mode fills the pane exactly (object-contain, never a CSS zoom) */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-[#090b0e]">
        {liveMode ? (
          <div
            ref={viewportRef}
            tabIndex={0}
            title="Click to interact — keyboard goes to the page"
            onPointerDown={(e) => {
              const p = framePoint(e);
              if (!p) return;
              e.currentTarget.focus();
              const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
              sendInput({ kind: "click", x: p.x, y: p.y, button });
            }}
            onWheel={(e) => {
              e.preventDefault();
              const p = framePoint(e);
              if (!p) return;
              flushWheel(p.x, p.y, e.deltaX, e.deltaY);
            }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={handleViewportKey}
            className="relative flex-1 min-h-0 w-full cursor-crosshair outline-none"
          >
            {liveFrame ? (
              <img
                src={`data:image/jpeg;base64,${liveFrame.b64}`}
                alt="Live browser viewport"
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-[var(--oh-muted)]">
                {liveStatus === "offline"
                  ? "Live view unavailable — CDP offline"
                  : "Attaching live view…"}
              </div>
            )}
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
              LIVE{liveFrame ? ` ${liveFrame.w}×${liveFrame.h}` : ""}
            </div>
          </div>
        ) : hasPage ? (
          <div className={zoomFull ? "p-2 min-w-max" : "p-2.5 flex flex-1 items-start justify-center"}>
            <img
              src={imgSrc}
              alt="Browser viewport snapshot"
              className={
                zoomFull
                  ? "rounded border border-[var(--oh-border)] shadow-lg"
                  : "w-full rounded border border-[var(--oh-border)] object-contain shadow-lg"
              }
            />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 text-center p-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--oh-border)] bg-[var(--oh-surface)]">
              <Globe className="h-5 w-5 text-emerald-400" />
            </div>
            <p className="text-xs font-medium text-[var(--oh-text)]">
              {displayUrl
                ? `Active page: ${shortHost(displayUrl)}`
                : hpMode === "huntproxy" && !hpBrowserActive
                ? "Agent Browser Standby"
                : "Live Agent Browser"}
            </p>
            <p className="max-w-xs text-[11px] leading-relaxed text-[var(--oh-muted)]">
              {displayUrl
                ? `Tracked ${displayUrl}. Live viewport screenshots stream here when HuntProxy Chromium captures a frame.`
                : hpMode === "offline"
                ? "HuntProxy is offline on local PC dev. On the VPS, HuntProxy Chromium frames, tabs, and Take Control stream here live."
                : !hpBrowserActive
                ? "No browser is running yet. It opens automatically when Hermes uses the browser in a bug hunting workflow."
                : "Waiting for HuntProxy Chromium frames and browser events."}
            </p>
            {displayUrl && (
              <div className="flex items-center gap-2 mt-1">
                <a
                  href={displayUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-[var(--oh-border)] bg-[var(--oh-surface)] px-3 py-1 text-[11px] text-[var(--oh-text)] hover:bg-[var(--oh-elevated)]"
                >
                  Open in New Tab ↗
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible Activity Timeline */}
      {showTimeline && timeline.length > 0 && (
        <div className="shrink-0 max-h-36 overflow-y-auto border-t border-[var(--oh-border)] bg-[var(--oh-surface)] divide-y divide-[var(--oh-border)]">
          {[...timeline].reverse().map((ev, i) => (
            <div
              key={`${ev.t}-${ev.ts}-${i}`}
              className="flex items-center gap-2 px-2.5 py-1 text-[10px] font-mono"
            >
              <span className="uppercase px-1.5 py-0.5 rounded bg-white/10 text-[var(--oh-text)] shrink-0">
                {ev.t}
              </span>
              <span className="truncate text-[var(--oh-muted)] flex-1 min-w-0">
                {ev.url || ev.message || ev.text || ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* History Filmstrip */}
      {history.length > 1 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[var(--oh-border)] bg-[var(--oh-surface)] px-2 py-1.5">
          {history.map((item, idx) => {
            const isActive = idx === activeIdx;
            return (
              <button
                key={`${item.url}-${item.timestamp}-${idx}`}
                type="button"
                onClick={() => setSelectedHistoryIdx(idx)}
                title={item.url}
                className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-mono cursor-pointer transition-colors ${
                  isActive
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : "border-[var(--oh-border)] bg-[var(--oh-canvas)] text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
                }`}
              >
                {idx + 1}. {shortHost(item.url) || item.action || "step"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
