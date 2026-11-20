import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BookmarkPlus,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { apiFetch } from "../lib/apiFetch";
import { usePanelBridgeStore } from "../stores/panelBridgeStore";

interface HuntProxyProject {
  id: number;
  name: string;
  target_url?: string;
}

interface TrafficEntry {
  id: string;
  exchange_id?: number;
  sequence?: number;
  source?: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number;
  mime?: string;
  duration_ms: number;
  req_headers?: Record<string, string>;
  req_body_preview?: string;
  res_headers?: Record<string, string>;
  res_body_preview?: string;
  timestamp?: number;
}

interface LocalProxyStatus {
  session_id: string;
  running: boolean;
  host: string;
  port: number | null;
  proxy_url: string;
  entry_count: number;
}

const SOURCE_FILTERS = ["all", "browser", "proxy", "replay", "fuzzer"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

function statusBadgeClass(code: number): string {
  if (code >= 500) return "bg-red-500/15 text-red-400 border-red-500/30";
  if (code >= 400) return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (code >= 300) return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  if (code >= 200) return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  return "bg-white/5 text-[var(--oh-muted)] border-[var(--oh-border)]";
}

function sourceChipClass(source?: string): string {
  const s = (source || "").toLowerCase();
  if (s === "browser") return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  if (s === "proxy") return "bg-purple-500/15 text-purple-300 border-purple-500/30";
  if (s === "replay" || s === "reply") return "bg-blue-500/15 text-blue-300 border-blue-500/30";
  if (s === "fuzzer") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-white/5 text-[var(--oh-muted)] border-[var(--oh-border)]";
}

function formatHeaders(headers?: Record<string, string>): string {
  const keys = Object.keys(headers || {});
  if (keys.length === 0) return "(no headers)";
  return keys.map((k) => `${k}: ${headers?.[k] ?? ""}`).join("\n");
}

function normalizeHpEntry(raw: Record<string, unknown>): TrafficEntry {
  const eid = Number(raw.exchange_id ?? raw.id ?? 0) || undefined;
  const host = String(raw.host ?? "");
  const path = String(raw.path ?? "/");
  const url = String(raw.url ?? (host ? `https://${host}${path}` : path));
  return {
    id: eid ? `hp-${eid}` : `hp-${String(raw.sequence ?? Math.random())}`,
    exchange_id: eid,
    sequence: typeof raw.sequence === "number" ? raw.sequence : undefined,
    source: String(raw.source ?? "proxy").toLowerCase(),
    method: String(raw.method ?? "GET").toUpperCase(),
    url,
    host,
    path,
    status: Number(raw.status ?? raw.status_code ?? 0),
    mime: raw.mime ? String(raw.mime) : undefined,
    duration_ms: Number(raw.duration_ms ?? raw.duration ?? 0),
  };
}

export default function HttpProxyTab({ sessionId }: { sessionId: string }) {
  const program = usePanelBridgeStore((s) => s.program || "default");

  // HuntProxy state
  const [hpOnline, setHpOnline] = useState<boolean | null>(null);
  const [hpProjects, setHpProjects] = useState<HuntProxyProject[]>([]);
  const [hpProjectId, setHpProjectId] = useState<number | null>(null);
  const [hpReason, setHpReason] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [useLocalFallback, setUseLocalFallback] = useState(false);

  // Shared traffic list + inspector
  const [entries, setEntries] = useState<TrafficEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"response" | "request">("response");
  const [detailText, setDetailText] = useState<string>("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [pinnedNotice, setPinnedNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  // Cursor refs for HuntProxy resumable SSE
  const cursorRef = useRef<{ afterSeq: number | null; runtimeGen: string }>({
    afterSeq: null,
    runtimeGen: "",
  });

  // Local fallback proxy state
  const [localStatus, setLocalStatus] = useState<LocalProxyStatus>({
    session_id: sessionId,
    running: false,
    host: "127.0.0.1",
    port: null,
    proxy_url: "",
    entry_count: 0,
  });

  // 1. Probe HuntProxy projects & server-side per-session project resolution
  const loadProjects = useCallback(async () => {
    try {
      const res = await apiFetch<{
        online?: boolean;
        projects?: HuntProxyProject[];
        project_id?: number | null;
        reason?: string;
      }>(`/api/cockpit/traffic/projects?session_id=${encodeURIComponent(sessionId)}`);
      const online = Boolean(res?.online);
      setHpOnline(online);
      setHpProjects(Array.isArray(res?.projects) ? res.projects : []);
      setHpProjectId(typeof res?.project_id === "number" ? res.project_id : null);
      setHpReason(res?.reason || "");
    } catch {
      setHpOnline(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // 2. HuntProxy history backfill + SSE stream when online
  useEffect(() => {
    if (!hpOnline || hpProjectId === null || useLocalFallback) return;

    let cancelled = false;
    let es: EventSource | null = null;
    cursorRef.current = { afterSeq: null, runtimeGen: "" };

    const startStream = () => {
      if (cancelled) return;
      const params = new URLSearchParams({ project_id: String(hpProjectId) });
      if (cursorRef.current.afterSeq !== null) {
        params.set("after_sequence", String(cursorRef.current.afterSeq));
      }
      if (cursorRef.current.runtimeGen) {
        params.set("runtime_generation", cursorRef.current.runtimeGen);
      }
      es = new EventSource(`/api/cockpit/traffic/stream?${params.toString()}`, {
        withCredentials: true,
      });

      const handlePayload = (rawData: string) => {
        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          if (parsed.t === "offline") return;
          if (typeof parsed.runtime_generation === "string" || typeof parsed.runtime_generation === "number") {
            cursorRef.current.runtimeGen = String(parsed.runtime_generation);
          }
          if (typeof parsed.sequence === "number") {
            cursorRef.current.afterSeq = parsed.sequence;
          }
          const inner = (parsed.exchange as Record<string, unknown> | undefined) ?? parsed;
          if (inner && (inner.exchange_id || inner.method || inner.path)) {
            const norm = normalizeHpEntry(inner);
            setEntries((prev) => {
              if (prev.some((item) => item.id === norm.id)) return prev;
              return [...prev.slice(-499), norm];
            });
          }
        } catch {
          // ignore keepalive / non-exchange event
        }
      };

      es.addEventListener("ready", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
          if (d.runtime_generation != null) {
            cursorRef.current.runtimeGen = String(d.runtime_generation);
          }
        } catch {
          // ignore
        }
      });
      es.addEventListener("exchange", (ev) => handlePayload((ev as MessageEvent).data));
      es.onmessage = (ev) => handlePayload(ev.data);
    };

    void apiFetch<{
      online?: boolean;
      entries?: Record<string, unknown>[];
      runtime_generation?: string | number;
      last_sequence?: number;
    }>(`/api/cockpit/traffic/history?project_id=${hpProjectId}&limit=200`)
      .then((res) => {
        if (cancelled) return;
        if (res?.runtime_generation != null) {
          cursorRef.current.runtimeGen = String(res.runtime_generation);
        }
        const list = (res?.entries || []).map(normalizeHpEntry);
        if (typeof res?.last_sequence === "number") {
          cursorRef.current.afterSeq = res.last_sequence;
        } else if (list.length > 0 && list[list.length - 1].sequence != null) {
          cursorRef.current.afterSeq = list[list.length - 1].sequence ?? null;
        }
        setEntries(list);
        startStream();
      })
      .catch(() => {
        if (!cancelled) startStream();
      });

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [hpOnline, hpProjectId, useLocalFallback]);

  // 3. Local fallback capture proxy when explicitly enabled
  useEffect(() => {
    if (!useLocalFallback) return;
    void apiFetch<{ entries?: TrafficEntry[]; status?: LocalProxyStatus }>(
      `/api/cockpit/proxy/entries?session_id=${encodeURIComponent(sessionId)}`
    )
      .then((data) => {
        if (data.status) setLocalStatus(data.status);
        if (Array.isArray(data.entries)) {
          setEntries(data.entries.map((e) => ({ ...e, source: e.source || "proxy" })));
        }
      })
      .catch(() => {});

    const es = new EventSource(
      `/api/cockpit/proxy/stream?session_id=${encodeURIComponent(sessionId)}`,
      { withCredentials: true }
    );
    es.addEventListener("proxy_status", (ev) => {
      try {
        setLocalStatus(JSON.parse((ev as MessageEvent).data));
      } catch {
        // ignore
      }
    });
    es.addEventListener("proxy_entry", (ev) => {
      try {
        const entry = JSON.parse((ev as MessageEvent).data) as TrafficEntry;
        setEntries((prev) =>
          prev.some((i) => i.id === entry.id) ? prev : [...prev.slice(-499), { ...entry, source: "proxy" }]
        );
      } catch {
        // ignore
      }
    });
    es.addEventListener("proxy_cleared", () => {
      setEntries([]);
      setSelectedId(null);
    });
    return () => es.close();
  }, [sessionId, useLocalFallback]);

  const handleSelectProject = async (nextId: number) => {
    setHpProjectId(nextId);
    setEntries([]);
    setSelectedId(null);
    try {
      const res = await apiFetch<{ project_id?: number; reason?: string }>(
        "/api/cockpit/traffic/project",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, project_id: nextId }),
        }
      );
      if (res?.reason) setHpReason(res.reason);
    } catch {
      // ignore
    }
  };

  const filteredEntries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...entries]
      .filter((e) => {
        if (sourceFilter !== "all") {
          const src = (e.source || "").toLowerCase();
          if (sourceFilter === "replay") {
            if (src !== "replay" && src !== "reply") return false;
          } else if (src !== sourceFilter) {
            return false;
          }
        }
        if (!q) return true;
        return (
          e.url.toLowerCase().includes(q) ||
          e.method.toLowerCase().includes(q) ||
          String(e.status).includes(q) ||
          (e.source || "").toLowerCase().includes(q)
        );
      })
      .reverse();
  }, [entries, filter, sourceFilter]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? filteredEntries[0] ?? null,
    [entries, filteredEntries, selectedId]
  );

  // Lazy-fetch HuntProxy exchange detail + body on row select
  useEffect(() => {
    if (!selectedEntry) {
      setDetailText("");
      return;
    }
    if (!selectedEntry.exchange_id || !hpOnline || hpProjectId === null || useLocalFallback) {
      setDetailText(
        inspectorTab === "request"
          ? `${selectedEntry.method} ${selectedEntry.url}\n${formatHeaders(selectedEntry.req_headers)}${
              selectedEntry.req_body_preview ? `\n\n${selectedEntry.req_body_preview}` : ""
            }`
          : `HTTP ${selectedEntry.status} (${selectedEntry.duration_ms}ms)\n${formatHeaders(
              selectedEntry.res_headers
            )}${selectedEntry.res_body_preview ? `\n\n${selectedEntry.res_body_preview}` : ""}`
      );
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    void apiFetch<{
      exchange?: Record<string, unknown> | null;
      body?: Record<string, unknown> | string | null;
    }>(
      `/api/cockpit/traffic/exchange?project_id=${hpProjectId}&exchange_id=${selectedEntry.exchange_id}&side=${inspectorTab}`
    )
      .then((res) => {
        if (cancelled) return;
        const ex = res?.exchange || {};
        const hdrs =
          inspectorTab === "request"
            ? (ex.request_headers as Record<string, string> | undefined)
            : (ex.response_headers as Record<string, string> | undefined);
        const bodyRaw =
          typeof res?.body === "string"
            ? res.body
            : res?.body && typeof res.body === "object"
            ? String(res.body.text ?? res.body.body ?? res.body.content ?? JSON.stringify(res.body, null, 2))
            : "";
        const headLine =
          inspectorTab === "request"
            ? `${selectedEntry.method} ${selectedEntry.url}`
            : `HTTP ${selectedEntry.status} (${selectedEntry.duration_ms}ms)`;
        setDetailText(`${headLine}\n${formatHeaders(hdrs)}${bodyRaw ? `\n\n${bodyRaw}` : ""}`);
      })
      .catch(() => {
        if (!cancelled) setDetailText("(failed to load exchange body)");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, inspectorTab, hpOnline, hpProjectId, useLocalFallback]);

  const handlePinToFinding = async () => {
    if (!selectedEntry) return;
    setBusy(true);
    setPinnedNotice(null);
    try {
      await apiFetch("/api/cockpit/findings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          program,
          title: `${selectedEntry.method} ${selectedEntry.path} (${selectedEntry.status})`,
          severity: "info",
          target: selectedEntry.url,
          body: `### Evidence (${selectedEntry.source || "proxy"})\n\n\`\`\`http\n${detailText.slice(
            0,
            6000
          )}\n\`\`\``,
        }),
      });
      setPinnedNotice("Pinned to Findings");
      setTimeout(() => setPinnedNotice(null), 2500);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleLocalProxy = async () => {
    setBusy(true);
    try {
      const endpoint = localStatus.running
        ? "/api/cockpit/proxy/stop"
        : "/api/cockpit/proxy/start";
      const next = await apiFetch<LocalProxyStatus>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      setLocalStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const handleClearLocal = async () => {
    setBusy(true);
    try {
      const next = await apiFetch<LocalProxyStatus>("/api/cockpit/proxy/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      setLocalStatus(next);
      setEntries([]);
      setSelectedId(null);
    } finally {
      setBusy(false);
    }
  };

  const handleReplayLocal = async (entry: TrafficEntry) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ entry?: TrafficEntry }>("/api/cockpit/proxy/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          method: entry.method,
          url: entry.url,
          headers: entry.req_headers || {},
          body: entry.req_body_preview || "",
        }),
      });
      if (res.entry) setSelectedId(res.entry.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 border-b border-[var(--oh-border)] bg-[var(--oh-surface)]">
        {hpOnline && !useLocalFallback ? (
          <>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
            <select
              aria-label="HuntProxy project"
              value={hpProjectId ?? ""}
              onChange={(e) => void handleSelectProject(Number(e.target.value))}
              title={hpReason ? `Auto-match: ${hpReason}` : "HuntProxy project"}
              className="flex-1 min-w-0 rounded border border-[var(--oh-border)] bg-[var(--oh-canvas)] px-2 py-1 text-[11px] font-mono text-[var(--oh-text)]"
            >
              {hpProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadProjects()}
              title="Refresh HuntProxy projects"
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--oh-border)] text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </>
        ) : useLocalFallback ? (
          <>
            <span
              className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                localStatus.running ? "bg-emerald-400" : "bg-zinc-500"
              }`}
            />
            <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-[var(--oh-text)]">
              {localStatus.running && localStatus.proxy_url
                ? localStatus.proxy_url
                : "Local proxy stopped"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleToggleLocalProxy()}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium border cursor-pointer ${
                localStatus.running
                  ? "border-red-500/30 bg-red-500/15 text-red-400"
                  : "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
              }`}
            >
              {localStatus.running ? (
                <>
                  <Square className="h-3 w-3" /> Stop
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" /> Start
                </>
              )}
            </button>
            <button
              type="button"
              disabled={busy || entries.length === 0}
              onClick={() => void handleClearLocal()}
              className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] px-2 py-0.5 text-[11px] text-[var(--oh-muted)] hover:text-[var(--oh-text)] disabled:opacity-40 cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            {hpOnline && (
              <button
                type="button"
                onClick={() => setUseLocalFallback(false)}
                className="rounded border border-[var(--oh-border)] px-2 py-0.5 text-[10px] text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
              >
                HuntProxy
              </button>
            )}
          </>
        ) : (
          <>
            <span className="inline-block h-2 w-2 rounded-full bg-zinc-500 shrink-0" />
            <span className="text-[11px] text-[var(--oh-muted)] flex-1 min-w-0 truncate">
              HuntProxy offline (expected on PC dev)
            </span>
            <button
              type="button"
              onClick={() => void loadProjects()}
              title="Retry HuntProxy connection"
              className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] px-2 py-0.5 text-[10px] text-[var(--oh-muted)] hover:text-[var(--oh-text)] cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
            <button
              type="button"
              onClick={() => setUseLocalFallback(true)}
              className="rounded border border-[var(--oh-border)] px-2 py-0.5 text-[10px] text-[var(--oh-text)] hover:bg-white/5 cursor-pointer"
            >
              Local Proxy
            </button>
          </>
        )}
      </div>

      {/* Source Chips (Web Browser vs Mobile Proxy) + Search */}
      <div className="flex flex-col gap-1.5 px-2.5 py-1.5 border-b border-[var(--oh-border)] bg-[var(--oh-canvas)]">
        <div className="flex items-center gap-1 overflow-x-auto">
          {SOURCE_FILTERS.map((src) => (
            <button
              key={src}
              type="button"
              onClick={() => setSourceFilter(src)}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize cursor-pointer transition-colors ${
                sourceFilter === src
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-[var(--oh-border)] text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
              }`}
            >
              {src === "browser"
                ? "Browser (Web)"
                : src === "proxy"
                ? "Proxy (Mobile)"
                : src}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 rounded border border-[var(--oh-border)] bg-[var(--oh-surface)] px-2 py-1">
          <Search className="h-3 w-3 text-[var(--oh-muted)] shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter method, URL, status…"
            className="w-full bg-transparent text-[11px] text-[var(--oh-text)] placeholder:text-[var(--oh-muted)]"
          />
        </div>
      </div>

      {/* Traffic List */}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--oh-border)]">
        {filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-xs text-[var(--oh-muted)]">
            <Activity className="h-5 w-5 opacity-60" />
            <p className="font-medium text-[var(--oh-text)]">
              {hpOnline === false && !useLocalFallback
                ? "HuntProxy offline (expected on PC dev)"
                : "No HTTP traffic captured"}
            </p>
            <p className="text-[11px] max-w-[260px] leading-relaxed">
              {hpOnline && !useLocalFallback
                ? "Web browser requests (source: browser) and mobile proxy traffic (source: proxy) stream here live."
                : "Connect to the VPS with HuntProxy on 127.0.0.1:17890, or click Local Proxy for local capture."}
            </p>
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const active = selectedEntry?.id === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedId(entry.id)}
                className={`w-full text-left px-2.5 py-1.5 flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                  active ? "bg-white/10" : "hover:bg-white/5"
                }`}
              >
                <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/10 text-[var(--oh-text)] shrink-0">
                  {entry.method}
                </span>
                <span
                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${statusBadgeClass(
                    entry.status
                  )}`}
                >
                  {entry.status || "ERR"}
                </span>
                {entry.source && (
                  <span
                    className={`font-mono text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${sourceChipClass(
                      entry.source
                    )}`}
                  >
                    {entry.source}
                  </span>
                )}
                <span className="truncate font-mono text-[11px] text-[var(--oh-text)] flex-1 min-w-0">
                  {entry.url}
                </span>
                <span className="font-mono text-[10px] text-[var(--oh-muted)] shrink-0">
                  {entry.duration_ms}ms
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Inspector */}
      {selectedEntry && (
        <div className="border-t border-[var(--oh-border)] bg-[var(--oh-surface)] flex flex-col max-h-[48%] min-h-[150px]">
          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--oh-border)] gap-1.5">
            <div className="flex items-center gap-1">
              {(["response", "request"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setInspectorTab(tab)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize cursor-pointer ${
                    inspectorTab === tab
                      ? "bg-white/10 text-[var(--oh-text)]"
                      : "text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {pinnedNotice && (
                <span className="text-[10px] text-emerald-400">{pinnedNotice}</span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void handlePinToFinding()}
                title="Pin exchange to Findings"
                className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] px-2 py-0.5 text-[11px] text-[var(--oh-text)] hover:bg-white/10 cursor-pointer disabled:opacity-40"
              >
                <BookmarkPlus className="h-3 w-3" /> Pin
              </button>
              {useLocalFallback && selectedEntry.method !== "CONNECT" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleReplayLocal(selectedEntry)}
                  className="inline-flex items-center gap-1 rounded border border-[var(--oh-border)] px-2 py-0.5 text-[11px] text-[var(--oh-text)] hover:bg-white/10 cursor-pointer disabled:opacity-40"
                >
                  <RotateCw className="h-3 w-3" /> Replay
                </button>
              )}
            </div>
          </div>
          <pre className="flex-1 overflow-auto p-2.5 text-[11px] leading-relaxed font-mono text-[var(--oh-text)] whitespace-pre-wrap break-all m-0">
            {loadingDetail ? "Loading…" : detailText}
          </pre>
        </div>
      )}
    </div>
  );
}
