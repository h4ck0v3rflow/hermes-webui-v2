import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BookmarkPlus,
  MoreHorizontal,
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

/** HuntProxy returns headers as an ARRAY of {name, value, noisy, redacted} objects;
 * some legacy paths return a plain name→value record. Object.keys() over the array
 * produced "0: [object Object]" for every header — that is the bug this handles. */
type HeaderLike = Record<string, string> | Array<{ name?: string; key?: string; value?: string }>;

function formatHeaders(headers?: HeaderLike | null): string {
  if (!headers) return "(no headers)";
  if (Array.isArray(headers)) {
    const lines = headers
      .map((h) => {
        if (!h || typeof h !== "object") return "";
        const name = String(h.name ?? h.key ?? "").trim();
        if (!name) return "";
        return `${name}: ${String(h.value ?? "")}`;
      })
      .filter(Boolean);
    return lines.length ? lines.join("\n") : "(no headers)";
  }
  const keys = Object.keys(headers);
  if (keys.length === 0) return "(no headers)";
  const record = headers as Record<string, string>;
  return keys.map((k) => `${k}: ${record[k] ?? ""}`).join("\n");
}

/** HuntProxy pages bodies as base64 (`data` + `encoding`/`decoded`). Rendering the raw
 * record dumped megabyte-scale base64 into the pane and looked like a hang. */
function decodeBody(body: unknown): string {
  if (!body) return "(empty body)";
  if (typeof body === "string") return body;
  if (typeof body !== "object") return String(body);
  const rec = body as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  const data = rec.data;
  if (typeof data === "string" && data) {
    try {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      // Drop control bytes that would wreck the <pre> rendering.
      return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    } catch {
      return `(binary body — ${data.length} base64 chars, not rendered)`;
    }
  }
  return JSON.stringify(rec, null, 2).slice(0, 20000);
}

type HeaderPair = [string, string];

function toHeaderPairs(hdrs: unknown): HeaderPair[] {
  if (!hdrs) return [];
  if (Array.isArray(hdrs)) {
    return hdrs
      .map((h) => {
        const o = h as { name?: string; key?: string; value?: string };
        return [String(o?.name ?? o?.key ?? "").trim(), String(o?.value ?? "")] as HeaderPair;
      })
      .filter(([k]) => k.length > 0);
  }
  if (typeof hdrs === "object") {
    return Object.entries(hdrs as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]);
  }
  return [];
}

function shellQuoteBash(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePs(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function buildCurl(
  shell: "bash" | "ps",
  method: string,
  url: string,
  headers: HeaderPair[],
  body: string
): string {
  const q = shell === "bash" ? shellQuoteBash : shellQuotePs;
  const parts = [`curl${shell === "ps" ? ".exe" : ""} -X ${method.toUpperCase()}`, q(url)];
  for (const [k, v] of headers) {
    if (/^(content-length|host|connection|accept-encoding)$/i.test(k)) continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (body) parts.push(`--data-raw ${q(body)}`);
  return parts.join(shell === "bash" ? " \\\n  " : " `\n  ");
}

function buildPython(method: string, url: string, headers: HeaderPair[], body: string): string {
  const hdr = headers
    .filter(([k]) => !/^(content-length|host|connection|accept-encoding)$/i.test(k))
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  const bodyLine = body ? `\n    data=${JSON.stringify(body)},` : "";
  return `import requests\n\nresp = requests.request(\n    ${JSON.stringify(method.toUpperCase())},\n    ${JSON.stringify(
    url
  )},\n    headers={\n${hdr}\n    },${bodyLine}\n    timeout=30,\n)\nprint(resp.status_code, resp.text[:2000])`;
}

/** Pretty-print JSON when the body is JSON; otherwise leave it as-is. */
function prettyBody(text: string): { text: string; json: boolean } {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return { text, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
}

/** Token-level colouring for the body pane (JSON strings/numbers/bools + comments). */
function BodyHighlights({ text }: { text: string }) {
  const parts: Array<{ s: string; c?: string }> = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\/\/[^\n]*|#[^\n]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ s: text.slice(last, m.index) });
    if (m[1]) {
      parts.push({ s: m[1], c: m[2] ? "text-sky-300" : "text-emerald-300" });
      if (m[2]) parts.push({ s: m[2] });
    } else if (m[3]) {
      parts.push({ s: m[3], c: "text-fuchsia-300" });
    } else if (m[4]) {
      parts.push({ s: m[4], c: "text-amber-300" });
    } else if (m[5]) {
      parts.push({ s: m[5], c: "text-slate-500 italic" });
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ s: text.slice(last) });
  return (
    <>
      {parts.map((p, i) =>
        p.c ? (
          <span key={i} className={p.c}>
            {p.s}
          </span>
        ) : (
          <span key={i}>{p.s}</span>
        )
      )}
    </>
  );
}

function normalizeHpEntry(raw: Record<string, unknown>): TrafficEntry {
  const eid = Number(raw.exchange_id ?? raw.id ?? 0) || undefined;
  const host = String(raw.host ?? "");
  const path = String(raw.path ?? "/");
  const url = String(raw.url ?? (host ? `https://${host}${path}` : path));
  const startedRaw = String(raw.started_at ?? raw.timestamp ?? "");
  const startedMs = startedRaw ? Date.parse(startedRaw) : NaN;
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
    timestamp: Number.isFinite(startedMs) ? startedMs : undefined,
  };
}

export default function HttpProxyTab({
  sessionId,
  active = true,
}: {
  sessionId: string;
  /** False while another right-panel tab is showing. The pane stays mounted (state and
   * the row list survive a switch) but releases its SSE slots — HTTP/1.1 allows only 6
   * connections per origin, and the legacy shell already holds several streams. */
  active?: boolean;
}) {
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
  const [inspectorTab, setInspectorTab] = useState<"response" | "request">("request");
  const [detailText, setDetailText] = useState<string>("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailParts, setDetailParts] = useState<{ head: string; headers: HeaderPair[]; body: string } | null>(
    null
  );
  const [inspectorHeight, setInspectorHeight] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem("cockpit.inspectorHeight"));
    return Number.isFinite(saved) && saved >= 160 ? saved : 320;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  // "Session" hides everything captured before this browser tab started — the tab used to
  // render the project's whole saved history, which read as somebody else's traffic.
  const [scope, setScope] = useState<"session" | "all">("session");
  const sessionStartRef = useRef<number>(0);
  if (!sessionStartRef.current) {
    const key = `cockpit.traffic.since.${sessionId}`;
    const saved = Number(window.sessionStorage.getItem(key) || 0);
    const now = saved || Date.now();
    if (!saved) window.sessionStorage.setItem(key, String(now));
    sessionStartRef.current = now;
  }
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
    if (!active || !hpOnline || hpProjectId === null || useLocalFallback) return;

    let cancelled = false;
    let timer: number | undefined;
    cursorRef.current = { afterSeq: null, runtimeGen: "" };

    const startStream = () => {
      if (cancelled) return;
      const applyExchange = (parsed: Record<string, unknown>) => {
        if (parsed.t === "offline") return;
        if (parsed.runtime_generation != null) {
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
      };

      // Poll instead of holding an SSE slot. Browsers allow only 6 concurrent HTTP/1.1
      // connections per origin and the shell already holds several — our own stream was
      // starving every fetch, which is what made a row detail take minutes to appear.
      const tick = () => {
        if (cancelled) return;
        const params = new URLSearchParams({ project_id: String(hpProjectId), limit: "100" });
        if (cursorRef.current.afterSeq !== null) {
          params.set("after_sequence", String(cursorRef.current.afterSeq));
        }
        void apiFetch<{
          entries?: Record<string, unknown>[];
          runtime_generation?: string | number;
          last_sequence?: number;
        }>(`/api/cockpit/traffic/history?${params.toString()}`)
          .then((res) => {
            if (cancelled) return;
            for (const row of res?.entries ?? []) applyExchange(row as Record<string, unknown>);
            if (res?.runtime_generation != null) {
              cursorRef.current.runtimeGen = String(res.runtime_generation);
            }
            if (typeof res?.last_sequence === "number") {
              cursorRef.current.afterSeq = res.last_sequence;
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) timer = window.setTimeout(tick, 1500);
          });
      };
      tick();
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
      if (timer) window.clearTimeout(timer);
    };
  }, [active, hpOnline, hpProjectId, useLocalFallback]);

  // 3. Local fallback capture proxy when explicitly enabled
  useEffect(() => {
    if (!active || !useLocalFallback) return;
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
    const since = sessionStartRef.current;
    return [...entries]
      .filter((e) => {
        if (scope === "session" && e.timestamp && e.timestamp < since) return false;
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
  }, [entries, filter, sourceFilter, scope]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId]
  );

  // Pick the newest row ONCE, then keep it. Re-deriving on every poll made the inspector
  // refetch a different exchange every 1.5 s — the blinking "Loading…" the operator saw.
  useEffect(() => {
    if (selectedId) return;
    if (!filteredEntries.length) return;
    setSelectedId(filteredEntries[0].id);
  }, [filteredEntries, selectedId]);

  // Lazy-fetch HuntProxy exchange detail + body on row select.
  // The request-id guard is essential: the traffic SSE keeps appending rows, so this
  // effect re-runs while a fetch is in flight. Each run used to cancel the previous and
  // its cleanup skipped clearing `loadingDetail` — the pane sat on "Loading…" forever.
  const detailReqRef = useRef(0);
  // Per-exchange cache so Request/Response toggling is instant — no refetch, no spinner.
  const detailCacheRef = useRef(
    new Map<string, { text: string; head: string; headers: HeaderPair[]; body: string }>()
  );
  useEffect(() => {
    const reqId = (detailReqRef.current += 1);
    if (!selectedEntry) {
      setDetailText("");
      setLoadingDetail(false);
      return;
    }
    const head =
      inspectorTab === "request"
        ? `${selectedEntry.method} ${selectedEntry.url}`
        : `HTTP ${selectedEntry.status} (${selectedEntry.duration_ms}ms)`;

    if (!selectedEntry.exchange_id || !hpOnline || hpProjectId === null || useLocalFallback) {
      const hdrs = inspectorTab === "request" ? selectedEntry.req_headers : selectedEntry.res_headers;
      const preview =
        inspectorTab === "request" ? selectedEntry.req_body_preview : selectedEntry.res_body_preview;
      setDetailParts({ head, headers: toHeaderPairs(hdrs), body: preview ?? "" });
      setDetailText(`${head}\n${formatHeaders(hdrs)}${preview ? `\n\n${preview}` : ""}`);
      setLoadingDetail(false);
      return;
    }

    const exchangeId = selectedEntry.exchange_id;
    const cacheKey = `${exchangeId}:${inspectorTab}`;
    const cached = detailCacheRef.current.get(cacheKey);
    if (cached) {
      setDetailParts({ head: cached.head, headers: cached.headers, body: cached.body });
      setDetailText(cached.text);
      setLoadingDetail(false);
      return;
    }

    const build = (
      side: "request" | "response",
      res: { exchange?: Record<string, unknown> | null; body?: unknown } | null
    ): { text: string; head: string; headers: HeaderPair[]; body: string } => {
      const ex = res?.exchange || {};
      const hdrs = toHeaderPairs(side === "request" ? ex.request_headers : ex.response_headers);
      const line =
        side === "request"
          ? `${selectedEntry.method} ${selectedEntry.url}`
          : `HTTP ${selectedEntry.status} (${selectedEntry.duration_ms}ms)`;
      const body = decodeBody(res?.body);
      return { text: `${line}\n${formatHeaders(hdrs as HeaderLike)}\n\n${body}`, head: line, headers: hdrs, body };
    };

    const loadSide = (side: "request" | "response") =>
      apiFetch<{ exchange?: Record<string, unknown> | null; body?: unknown }>(
        `/api/cockpit/traffic/exchange?project_id=${hpProjectId}&exchange_id=${exchangeId}&side=${side}`
      );

    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => {
          window.setTimeout(() => reject(new Error("timeout")), ms);
        }),
      ]);

    setLoadingDetail(true);
    setDetailText(`${head}\n\nLoading body…`);
    void withTimeout(loadSide(inspectorTab), 12_000)
      .then((res) => {
        const bundle = build(inspectorTab, res);
        detailCacheRef.current.set(cacheKey, bundle);
        if (reqId !== detailReqRef.current) return;
        setDetailParts({ head: bundle.head, headers: bundle.headers, body: bundle.body });
        setDetailText(bundle.text);
      })
      .catch(() => {
        if (reqId === detailReqRef.current) setDetailText(`${head}\n(failed to load exchange body — timed out)`);
      })
      .finally(() => {
        if (reqId === detailReqRef.current) setLoadingDetail(false);
      });

    // Prime the other side in the background so the toggle is instant when clicked.
    const other = inspectorTab === "request" ? "response" : "request";
    const otherKey = `${exchangeId}:${other}`;
    if (!detailCacheRef.current.has(otherKey)) {
      void withTimeout(loadSide(other), 12_000)
        .then((res) => detailCacheRef.current.set(otherKey, build(other, res)))
        .catch(() => undefined);
    }
  }, [selectedEntry, inspectorTab, hpOnline, hpProjectId, useLocalFallback]);

  const copyAs = async (kind: "bash" | "ps" | "py" | "url" | "headers" | "body") => {
    if (!selectedEntry) return;
    const id = selectedEntry.exchange_id;
    let req = id ? detailCacheRef.current.get(`${id}:request`) : undefined;
    if (!req && id && hpOnline && hpProjectId !== null && !useLocalFallback) {
      try {
        const res = await apiFetch<{ exchange?: Record<string, unknown> | null; body?: unknown }>(
          `/api/cockpit/traffic/exchange?project_id=${hpProjectId}&exchange_id=${id}&side=request`
        );
        const ex = res?.exchange || {};
        const hdrs = toHeaderPairs(ex.request_headers);
        const body = decodeBody(res?.body);
        req = { text: "", head: "", headers: hdrs, body };
      } catch {
        req = undefined;
      }
    }
    const headers = req?.headers?.length ? req.headers : toHeaderPairs(selectedEntry.req_headers);
    const body = req?.body ?? selectedEntry.req_body_preview ?? "";
    let text = "";
    switch (kind) {
      case "bash":
        text = buildCurl("bash", selectedEntry.method, selectedEntry.url, headers, body);
        break;
      case "ps":
        text = buildCurl("ps", selectedEntry.method, selectedEntry.url, headers, body);
        break;
      case "py":
        text = buildPython(selectedEntry.method, selectedEntry.url, headers, body);
        break;
      case "url":
        text = selectedEntry.url;
        break;
      case "headers":
        text = headers.map(([k, v]) => `${k}: ${v}`).join("\n");
        break;
      case "body":
        text = detailParts?.body ?? body;
        break;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // http:// on the tailnet is not a secure context — clipboard API is unavailable there.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    setCopyNotice(ok ? "Copied" : "Copy failed");
    setMenuOpen(false);
    window.setTimeout(() => setCopyNotice(""), 1600);
  };

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
          {(["session", "all"] as const).map((sc) => (
            <button
              key={sc}
              type="button"
              onClick={() => setScope(sc)}
              title={
                sc === "session"
                  ? "Only traffic captured since this tab opened"
                  : "Everything saved in this project's history"
              }
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide cursor-pointer transition-colors ${
                scope === sc
                  ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                  : "border-[var(--oh-border)] text-[var(--oh-muted)] hover:text-[var(--oh-text)]"
              }`}
            >
              {sc === "session" ? "This session" : "All saved"}
            </button>
          ))}
          <span className="mx-1 h-3 w-px shrink-0 bg-[var(--oh-border)]" />
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
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize"
            onMouseDown={(ev) => {
              ev.preventDefault();
              const startY = ev.clientY;
              const startH = inspectorHeight;
              const move = (m: MouseEvent) => {
                const next = Math.min(
                  Math.max(startH + (startY - m.clientY), 160),
                  Math.round(window.innerHeight * 0.75)
                );
                setInspectorHeight(next);
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                window.localStorage.setItem("cockpit.inspectorHeight", String(inspectorHeight));
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
            className="h-1.5 shrink-0 cursor-row-resize border-t border-[var(--oh-border)] hover:bg-emerald-500/40"
          />
          <div
            className="border-t border-[var(--oh-border)] bg-[var(--oh-surface)] flex flex-col shrink-0"
            style={{ height: inspectorHeight }}
          >
          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--oh-border)] gap-1.5">
            <div className="flex items-center gap-1">
              {(["request", "response"] as const).map((tab) => (
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
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  title="More actions"
                  className="inline-flex items-center rounded border border-[var(--oh-border)] px-1.5 py-0.5 text-[var(--oh-text)] hover:bg-white/10 cursor-pointer"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-[var(--oh-border)] bg-[var(--oh-surface)] py-1 shadow-xl">
                      {(
                        [
                          ["Copy as cURL (bash)", "bash"],
                          ["Copy as cURL (PowerShell)", "ps"],
                          ["Copy as Python (requests)", "py"],
                          ["Copy URL", "url"],
                          ["Copy headers", "headers"],
                          ["Copy body", "body"],
                        ] as const
                      ).map(([label, kind]) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => void copyAs(kind)}
                          className="block w-full px-3 py-1.5 text-left text-[11px] text-[var(--oh-text)] hover:bg-white/10 cursor-pointer"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {copyNotice && <span className="text-[10px] text-emerald-400">{copyNotice}</span>}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 text-[11px] leading-relaxed font-mono">
            {loadingDetail && <div className="text-[var(--oh-muted)]">Loading…</div>}
            {!loadingDetail && detailParts && (
              <>
                <div className="mb-1.5 select-all text-[var(--oh-muted)]">{detailParts.head}</div>
                <table className="mb-2 w-full border-collapse">
                  <tbody>
                    {detailParts.headers.map(([k, v], i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap pr-2 align-top text-sky-300/90">{k}:</td>
                        <td className="break-all align-top text-[var(--oh-text)]">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detailParts.body ? (
                  <pre className="m-0 whitespace-pre-wrap break-all font-mono">
                    <BodyHighlights text={prettyBody(detailParts.body).text.slice(0, 200000)} />
                  </pre>
                ) : (
                  <div className="text-[var(--oh-muted)]">(empty body)</div>
                )}
              </>
            )}
            {!loadingDetail && !detailParts && (
              <pre className="m-0 whitespace-pre-wrap break-all font-mono">{detailText}</pre>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
