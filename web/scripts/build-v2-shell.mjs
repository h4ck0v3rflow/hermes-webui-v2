import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

function shortHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const STATIC_DIR = path.join(REPO_ROOT, "static");
const OUT_DIR = path.join(STATIC_DIR, "v2");
const LOCALES_OUT_DIR = path.join(OUT_DIR, "locales");

const LEGACY_SCRIPTS_ORDER = [
  "icons.js",
  "assistant_turn_anchors.js",
  "a11y-helpers.js",
  "ui.js",
  "workspace.js",
  "terminal.js",
  "sessions.js",
  "commands.js",
  "messages.js",
  "extension_settings.js",
  "panels.js",
  "onboarding.js",
  "boot.js",
  "outline.js",
];

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Split static/i18n.js (1.9 MB) into:
 *  - static/v2/i18n-core.min.js (only 'en' inline + stub entries + lazy loader)
 *  - static/v2/locales/<lang>.js (loaded on demand when non-English locale is chosen)
 */
function buildSplitI18n() {
  const src = fs.readFileSync(path.join(STATIC_DIR, "i18n.js"), "utf8");
  const lines = src.split(/\r?\n/);

  const startIdx = lines.findIndex((l) => /^const LOCALES\s*=\s*\{/.test(l));
  const endIdx = lines.findIndex((l, idx) => idx > startIdx && /^\};$/.test(l));
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not locate LOCALES block in static/i18n.js");
  }

  const localeStarts = [];
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const m = /^  ([a-zA-Z0-9_-]+|'[^']+'):\s*\{$/.exec(lines[i]);
    if (m) {
      const key = m[1].replace(/^'|'$/g, "");
      localeStarts.push({ key, rawKey: m[1], line: i });
    }
  }
  if (localeStarts.length === 0) {
    throw new Error("No locale blocks found in static/i18n.js");
  }

  // Extract metadata (_lang, _label, _speech) safely from each block
  const stubs = [];
  let enBlockText = "";
  fs.mkdirSync(LOCALES_OUT_DIR, { recursive: true });

  for (let idx = 0; idx < localeStarts.length; idx += 1) {
    const cur = localeStarts[idx];
    const nextLine = idx + 1 < localeStarts.length ? localeStarts[idx + 1].line : endIdx;
    const blockLines = lines.slice(cur.line, nextLine);
    const blockStr = blockLines.join("\n");

    if (cur.key === "en") {
      enBlockText = blockStr;
      continue;
    }

    const langMatch = /_lang:\s*'([^']*)'/.exec(blockStr);
    const labelMatch = /_label:\s*'([^']*)'/.exec(blockStr);
    const speechMatch = /_speech:\s*'([^']*)'/.exec(blockStr);
    stubs.push(
      `  ${cur.rawKey}: { _lang: ${JSON.stringify(langMatch?.[1] ?? cur.key)}, _label: ${JSON.stringify(labelMatch?.[1] ?? cur.key)}, _speech: ${JSON.stringify(speechMatch?.[1] ?? cur.key)}, _stub: true }`
    );

    // Strip leading "  <key>: " and trailing "," from the object literal
    const openBraceIdx = blockStr.indexOf("{");
    const closeBraceIdx = blockStr.lastIndexOf("}");
    const objLiteral = blockStr.slice(openBraceIdx, closeBraceIdx + 1);

    const localeScript = `window.__HERMES_REGISTER_LOCALE__(${JSON.stringify(cur.key)}, ${objLiteral});\n`;
    const minifiedLocale = transformSync(localeScript, {
      loader: "js",
      minify: true,
      target: "es2020",
    });
    fs.writeFileSync(
      path.join(LOCALES_OUT_DIR, `${cur.key}.js`),
      minifiedLocale.code,
      "utf8"
    );
  }

  const tailHelpers = lines.slice(endIdx + 1).join("\n");
  // Inject lazy-loading hook into setLocale(lang)
  const patchedTail = tailHelpers.replace(
    /function setLocale\(lang\)\s*\{[\s\S]*?\n\}/,
    `window.__HERMES_REGISTER_LOCALE__ = function(lang, dict) {
  if (dict && typeof dict === 'object') {
    dict._loaded = true;
    LOCALES[lang] = dict;
    if ((resolveLocale(localStorage.getItem('hermes-lang')) || 'en') === lang) {
      _locale = dict;
      document.documentElement.lang = _locale._speech || lang;
      if (typeof applyLocaleToDOM === 'function') applyLocaleToDOM();
    }
  }
};
function _ensureLocaleLoaded(lang) {
  var entry = LOCALES[lang];
  if (!entry || !entry._stub || entry._loading) return;
  entry._loading = true;
  var s = document.createElement('script');
  var ver = window.__HERMES_WEBUI_BUNDLE_VERSION__ || '';
  s.src = 'static/v2/locales/' + encodeURIComponent(lang) + '.js' + (ver ? ('?v=' + encodeURIComponent(ver)) : '');
  s.async = true;
  document.head.appendChild(s);
}
function setLocale(lang) {
  const resolved = resolveLocale(lang) || 'en';
  const candidate = LOCALES[resolved];
  _locale = (candidate && !candidate._stub) ? candidate : LOCALES.en;
  try { localStorage.setItem('hermes-lang', resolved); } catch (_) {}
  document.documentElement.lang = (candidate && candidate._speech) || resolved;
  if (candidate && candidate._stub) {
    _ensureLocaleLoaded(resolved);
  }
}`
  );

  const coreSource = [
    lines.slice(0, startIdx + 1).join("\n"),
    enBlockText,
    stubs.join(",\n"),
    "};",
    patchedTail,
  ].join("\n");

  const minCore = transformSync(coreSource, {
    loader: "js",
    minify: true,
    target: "es2020",
  });
  const coreFileName = `i18n-core-${shortHash(minCore.code)}.min.js`;
  fs.writeFileSync(path.join(OUT_DIR, coreFileName), minCore.code, "utf8");

  return {
    coreFileName,
    originalBytes: Buffer.byteLength(src, "utf8"),
    coreBytes: Buffer.byteLength(minCore.code, "utf8"),
    localeCount: localeStarts.length - 1,
  };
}

/**
 * Minify legacy CSS and JS into static/v2/.
 */
function buildLegacyAssets() {
  const cssSrc = fs.readFileSync(path.join(STATIC_DIR, "style.css"), "utf8");
  const minCss = transformSync(cssSrc, {
    loader: "css",
    minify: true,
  });
  const cssFileName = `style-${shortHash(minCss.code)}.min.css`;
  fs.writeFileSync(path.join(OUT_DIR, cssFileName), minCss.code, "utf8");

  const legacyOutDir = path.join(OUT_DIR, "legacy");
  fs.mkdirSync(legacyOutDir, { recursive: true });

  let totalRawJs = 0;
  let totalMinJs = 0;
  const legacyHashes = {};
  for (const name of LEGACY_SCRIPTS_ORDER) {
    const filePath = path.join(STATIC_DIR, name);
    const code = fs.readFileSync(filePath, "utf8");
    totalRawJs += Buffer.byteLength(code, "utf8");
    const minJs = transformSync(code, {
      loader: "js",
      minify: true,
      target: "es2020",
    });
    totalMinJs += Buffer.byteLength(minJs.code, "utf8");
    legacyHashes[name] = shortHash(minJs.code);
    fs.writeFileSync(path.join(legacyOutDir, name), minJs.code, "utf8");
  }

  return {
    cssFileName,
    legacyHashes,
    cssOriginal: Buffer.byteLength(cssSrc, "utf8"),
    cssMin: Buffer.byteLength(minCss.code, "utf8"),
    jsOriginal: totalRawJs,
    jsMin: totalMinJs,
  };
}

/**
 * Runtime performance upgrades + window.__HERMES_PANEL_BRIDGE__ adapter.
 */
function buildPerfAndBridgeScript() {
  const src = `
(function() {
  // 1. Unregister any legacy service worker on /v2 scope so stale assets never pin
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(regs) {
      regs.forEach(function(r) {
        if (r.scope && r.scope.indexOf('/v2') !== -1) {
          r.unregister().catch(function(){});
        }
      });
    }).catch(function(){});
  }

  // 2. Visibility-aware interval throttling for background pollers (>= 2s)
  var _nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function(fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof fn === 'function' && typeof delay === 'number' && delay >= 2000) {
      var wrapped = function() {
        if (document.hidden) return;
        return fn.apply(this, args);
      };
      return _nativeSetInterval(wrapped, delay);
    }
    return _nativeSetInterval.apply(window, arguments);
  };

  // 2b. Keep browser URL under /v2 prefix when session URL helpers call history.pushState/replaceState
  var isV2Route = location.pathname === '/v2' || location.pathname.indexOf('/v2/') === 0;
  if (isV2Route && window.history) {
    ['pushState', 'replaceState'].forEach(function(method) {
      var orig = window.history[method];
      if (typeof orig !== 'function') return;
      window.history[method] = function(state, title, url) {
        if (url != null) {
          try {
            var u = new URL(String(url), location.origin + '/');
            if (u.origin === location.origin && u.pathname.indexOf('/v2') !== 0) {
              if (u.pathname === '/' || u.pathname.indexOf('/session/') === 0) {
                u.pathname = '/v2' + (u.pathname === '/' ? '' : u.pathname);
                url = u.pathname + u.search + u.hash;
              }
            }
          } catch (_) {}
        }
        return orig.call(this, state, title, url);
      };
    });
  }

  function getLegacyState() {
    try { return (typeof S !== 'undefined') ? S : null; } catch (_) { return null; }
  }
  window.__HERMES_GET_S__ = getLegacyState;

  function syncBridgeSession() {
    var st = getLegacyState();
    var sid = (st && st.session) ? (st.session.session_id || null) : null;
    var ws = (st && st.session) ? (st.session.workspace || '') : '';
    syncLiveWatcher(sid, ws);
    var b = window.__HERMES_PANEL_BRIDGE__;
    if (b) {
      b.setSession({ sessionId: sid, workspace: ws });
    } else if (sid) {
      window.__HERMES_PENDING_BRIDGE_STATE__ = Object.assign(
        window.__HERMES_PENDING_BRIDGE_STATE__ || {},
        { sessionId: sid, workspace: ws }
      );
    }
  }

  var EXTRA_TABS = { cmd: true, browser: true, findings: true, proxy: true };
  var EXTRA_TAB_BTN_IDS = {
    cmd: 'workspaceCmdTab',
    browser: 'workspaceBrowserTab',
    findings: 'workspaceFindingsTab',
    proxy: 'workspaceProxyTab'
  };
  var NATIVE_TAB_BTN_IDS = ['workspaceFilesTab', 'workspaceArtifactsTab', 'workspaceTodosTab'];
  var activeExtraTab = null;

  // Live agent file editing + session modified/added file tracker
  var liveState = {
    sessionId: null,
    es: null,
    edits: new Map(), // relPath -> { path, kind: 'created'|'modified'|'deleted', ts }
    expanded: false,
    refreshTimer: null,
    lastLivePath: null
  };

  function normRel(p) {
    if (!p) return '';
    var s = String(p).replace(/\\\\/g, '/').replace(/^~\\//, '').replace(/^(\\.\\/)+/, '');
    var st = getLegacyState();
    var ws = (st && st.session && st.session.workspace || '').replace(/\\\\/g, '/').replace(/\\/+$/, '');
    if (ws && s.indexOf(ws + '/') === 0) s = s.slice(ws.length + 1);
    return s;
  }

  function seedSessionEdits() {
    if (typeof window.collectSessionArtifacts !== 'function') return;
    try {
      var list = window.collectSessionArtifacts() || [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item || !item.path) continue;
        var rel = normRel(item.path);
        if (!rel || liveState.edits.has(rel)) continue;
        var src = String(item.source || '').toLowerCase();
        var kind = src.indexOf('creat') >= 0 || src.indexOf('write') >= 0 || src.indexOf('add') >= 0 ? 'created' : 'modified';
        liveState.edits.set(rel, { path: rel, kind: kind, ts: Date.now() });
      }
    } catch (_) {}
  }

  function renderLiveEditsBar() {
    var bar = document.getElementById('cockpitLiveEditsBar');
    if (!bar) return;
    var st = getLegacyState();
    var hasSession = Boolean(st && st.session && st.session.session_id);
    if (!hasSession || liveState.edits.size === 0) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    var items = Array.from(liveState.edits.values()).sort(function(a, b) { return b.ts - a.ts; });
    var count = items.length;
    var liveLabel = liveState.lastLivePath ? ('Live: ' + liveState.lastLivePath.split('/').pop()) : (count + ' session edit' + (count === 1 ? '' : 's'));

    bar.innerHTML = '';
    var hdr = document.createElement('button');
    hdr.type = 'button';
    hdr.className = 'cockpit-live-edits-hdr';
    hdr.onclick = function() {
      liveState.expanded = !liveState.expanded;
      renderLiveEditsBar();
    };
    var dot = document.createElement('span');
    dot.className = 'cockpit-live-dot';
    var title = document.createElement('span');
    title.className = 'cockpit-live-title';
    title.textContent = liveLabel;
    var countBadge = document.createElement('span');
    countBadge.className = 'cockpit-live-count';
    countBadge.textContent = String(count);
    var chev = document.createElement('span');
    chev.className = 'cockpit-live-chev';
    chev.textContent = liveState.expanded ? '▾' : '▸';
    hdr.appendChild(dot);
    hdr.appendChild(title);
    hdr.appendChild(countBadge);
    hdr.appendChild(chev);
    bar.appendChild(hdr);

    if (liveState.expanded) {
      var listEl = document.createElement('div');
      listEl.className = 'cockpit-live-edits-list';
      items.slice(0, 30).forEach(function(item) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'cockpit-live-edit-row';
        row.title = item.path;
        row.onclick = function() {
          if (typeof openExternalFile === 'function') {
            void openExternalFile(item.path);
          } else if (typeof window.openFile === 'function') {
            window.openFile(item.path, { bustCache: true });
          } else if (typeof window.openArtifactPath === 'function') {
            window.openArtifactPath(item.path);
          }
        };
        var tag = document.createElement('span');
        tag.className = 'cockpit-file-badge cockpit-file-badge--' + (item.kind === 'created' ? 'new' : item.kind === 'deleted' ? 'del' : 'mod');
        tag.textContent = item.kind === 'created' ? 'NEW' : item.kind === 'deleted' ? 'DEL' : 'MOD';
        var pathEl = document.createElement('span');
        pathEl.className = 'cockpit-live-edit-path';
        pathEl.textContent = item.path;
        row.appendChild(tag);
        row.appendChild(pathEl);
        listEl.appendChild(row);
      });
      bar.appendChild(listEl);
    }
    annotateFileTree();
  }

  function annotateFileTree() {
    var tree = document.getElementById('fileTree');
    if (!tree || liveState.edits.size === 0) return;
    var rows = tree.querySelectorAll('.file-item');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var rel = normRel(row.getAttribute('data-ws-path') || row.getAttribute('data-path') || row.getAttribute('title') || '');
      if (!rel) continue;
      var info = liveState.edits.get(rel);
      var existing = row.querySelector('.cockpit-file-badge');
      if (!info) {
        if (existing) existing.remove();
        continue;
      }
      var cls = info.kind === 'created' ? 'new' : info.kind === 'deleted' ? 'del' : 'mod';
      var lbl = info.kind === 'created' ? 'NEW' : info.kind === 'deleted' ? 'DEL' : 'MOD';
      if (!existing) {
        existing = document.createElement('span');
        row.appendChild(existing);
      }
      existing.className = 'cockpit-file-badge cockpit-file-badge--' + cls;
      existing.textContent = lbl;
    }
  }

  function handleLiveFileEvent(payload) {
    if (!payload || !payload.path) return;
    var rel = normRel(payload.path);
    if (!rel) return;
    var kind = payload.kind === 'created' || payload.kind === 'deleted' ? payload.kind : 'modified';
    liveState.edits.set(rel, { path: rel, kind: kind, ts: Date.now() });
    liveState.lastLivePath = rel;
    renderLiveEditsBar();

    // Auto-refresh open preview if agent is editing the currently viewed file
    try {
      var curPath = typeof _previewCurrentPath !== 'undefined' ? normRel(_previewCurrentPath) : '';
      var dirty = typeof _previewDirty !== 'undefined' ? Boolean(_previewDirty) : false;
      if (curPath && curPath === rel && !dirty && typeof window.openFile === 'function') {
        window.openFile(_previewCurrentPath, { bustCache: true });
      }
    } catch (_) {}

    if (kind === 'created' || kind === 'deleted') {
      if (liveState.refreshTimer) clearTimeout(liveState.refreshTimer);
      liveState.refreshTimer = setTimeout(function() {
        liveState.refreshTimer = null;
        if (typeof window.refreshWorkspacePanel === 'function') {
          window.refreshWorkspacePanel();
        }
      }, 400);
    }
  }

  function syncLiveWatcher(sid, ws) {
    if (sid === liveState.sessionId && liveState.es) return;
    if (liveState.es) {
      try { liveState.es.close(); } catch (_) {}
      liveState.es = null;
    }
    if (sid !== liveState.sessionId) {
      liveState.edits.clear();
      liveState.lastLivePath = null;
    }
    liveState.sessionId = sid;
    seedSessionEdits();
    renderLiveEditsBar();
    if (!sid || !ws || typeof EventSource === 'undefined') return;
    try {
      var es = new EventSource('/api/cockpit/files/stream?session_id=' + encodeURIComponent(sid));
      var onFileEv = function(ev) {
        try {
          handleLiveFileEvent(JSON.parse(ev.data));
        } catch (_) {}
      };
      es.addEventListener('file_delta', onFileEv);
      es.addEventListener('file_changed', onFileEv);
      liveState.es = es;
    } catch (_) {}
  }

  // Workspace Back (can exit workspace root) / Home (workspace root) / Forward (previously visited)
  var wsNav = {
    forwardStack: [],
    externalDir: null,
    externalParent: null,
    externalFile: null,
    suppressClear: false
  };

  function isPreviewOpen() {
    var pa = document.getElementById('previewArea');
    return Boolean(pa && pa.classList.contains('visible'));
  }

  function currentLocationEntry() {
    if (wsNav.externalFile) return { mode: 'ext-file', path: wsNav.externalFile, dir: wsNav.externalDir };
    if (wsNav.externalDir) return { mode: 'ext-dir', path: wsNav.externalDir };
    if (isPreviewOpen()) {
      try {
        if (typeof _previewCurrentPath !== 'undefined' && _previewCurrentPath) {
          return { mode: 'ws-file', path: _previewCurrentPath };
        }
      } catch (_) {}
    }
    var st = getLegacyState();
    return { mode: 'ws-dir', path: (st && st.currentDir) ? st.currentDir : '.' };
  }

  function syncWsNavButtons() {
    var st = getLegacyState();
    var hasSession = Boolean(st && st.session && st.session.session_id);
    var backBtn = document.getElementById('btnWsBack');
    var homeBtn = document.getElementById('btnWsHome');
    var fwdBtn = document.getElementById('btnWsForward');
    if (backBtn) {
      var canBack = hasSession && (!wsNav.externalDir || Boolean(wsNav.externalParent) || Boolean(wsNav.externalFile));
      backBtn.disabled = !canBack;
    }
    if (homeBtn) {
      var atHome = !wsNav.externalDir && !wsNav.externalFile && !isPreviewOpen() && (!st || !st.currentDir || st.currentDir === '.');
      homeBtn.disabled = !hasSession || atHome;
    }
    if (fwdBtn) {
      fwdBtn.disabled = !hasSession || wsNav.forwardStack.length === 0;
    }
  }

  function renderExternalBreadcrumb(fullPath) {
    var bar = document.getElementById('breadcrumbBar');
    if (!bar) return;
    bar.style.display = 'flex';
    bar.innerHTML = '';
    var norm = String(fullPath || '').replace(/\\\\/g, '/');
    var parts = norm.split('/').filter(Boolean);
    var isUncOrUnixRoot = norm.indexOf('/') === 0;
    var acc = isUncOrUnixRoot ? '' : '';
    if (isUncOrUnixRoot) {
      var rootSeg = document.createElement('span');
      rootSeg.className = 'breadcrumb-seg breadcrumb-link';
      rootSeg.textContent = '/';
      rootSeg.onclick = function() { void loadExternalDir('/'); };
      bar.appendChild(rootSeg);
    }
    parts.forEach(function(part, idx) {
      if (idx > 0 || isUncOrUnixRoot) {
        var sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '/';
        bar.appendChild(sep);
      }
      acc = acc ? (acc + '/' + part) : (isUncOrUnixRoot ? ('/' + part) : (part.endsWith(':') ? (part + '/') : part));
      var target = acc;
      var seg = document.createElement('span');
      seg.textContent = part;
      if (idx < parts.length - 1) {
        seg.className = 'breadcrumb-seg breadcrumb-link';
        seg.onclick = function() { void loadExternalDir(target); };
      } else {
        seg.className = 'breadcrumb-seg breadcrumb-current';
      }
      bar.appendChild(seg);
    });
  }

  var previewModeState = {
    path: '',
    content: null,
    mode: 'styled'
  };

  function syncPreviewModeTabsUi() {
    var wrap = document.getElementById('cockpitPreviewModeTabs');
    var styledBtn = document.getElementById('btnPreviewStyled');
    var rawBtn = document.getElementById('btnPreviewRaw');
    var hasText = previewModeState.content !== null;
    if (wrap) wrap.hidden = !hasText;
    if (styledBtn) {
      styledBtn.classList.toggle('active', previewModeState.mode === 'styled');
      styledBtn.setAttribute('aria-selected', previewModeState.mode === 'styled' ? 'true' : 'false');
    }
    if (rawBtn) {
      rawBtn.classList.toggle('active', previewModeState.mode === 'raw');
      rawBtn.setAttribute('aria-selected', previewModeState.mode === 'raw' ? 'true' : 'false');
    }
  }

  // Prism is loaded from a CDN and its autoloader silently no-ops when the network or CSP
  // blocks it — which left "Styled" rendering identical to "Raw". Fall back to a tiny
  // built-in tokenizer so styled code is always styled. (No backticks in this block: it is
  // injected inside a template literal.)
  var CK_KEYWORDS = 'def|class|import|from|return|if|else|elif|for|while|try|except|finally|with|as|lambda|yield|global|nonlocal|pass|raise|assert|del|None|True|False|and|or|not|in|is|async|await|const|let|var|function|new|export|default|extends|implements|public|private|protected|static|void|int|float|string|bool|char|struct|enum|fn|impl|use|mod|pub|match|package|func|type|interface|range|switch|case|break|continue|this|self|super|null|undefined|true|false|end|then|do|begin|module|require|include';

  function cockpitFallbackHighlight(el, text) {
    if (!text || text.length > 200000) return;
    var kw = {};
    CK_KEYWORDS.split('|').forEach(function (k) { kw[k] = 1; });
    var esc = function (s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text.charAt(i);
      // quoted string (straight quotes only; handles backslash escapes)
      if (ch === '"' || ch === "'") {
        var j = i + 1;
        while (j < n && text.charAt(j) !== ch && text.charCodeAt(j) !== 10) {
          if (text.charCodeAt(j) === 92) j += 1;
          j += 1;
        }
        j = Math.min(j + 1, n);
        out += '<span class="ck-str">' + esc(text.slice(i, j)) + '</span>';
        i = j;
        continue;
      }
      // line comment
      if (ch === '#' || (ch === '/' && text.charAt(i + 1) === '/')) {
        var e = text.indexOf(String.fromCharCode(10), i);
        if (e < 0) e = n;
        out += '<span class="ck-cmt">' + esc(text.slice(i, e)) + '</span>';
        i = e;
        continue;
      }
      // identifier / keyword
      if (/[A-Za-z_$]/.test(ch)) {
        var k = i;
        while (k < n && /[A-Za-z0-9_$]/.test(text.charAt(k))) k += 1;
        var w = text.slice(i, k);
        out += kw[w] ? '<span class="ck-kw">' + esc(w) + '</span>' : esc(w);
        i = k;
        continue;
      }
      // number
      if (/[0-9]/.test(ch)) {
        var q = i;
        while (q < n && /[0-9.]/.test(text.charAt(q))) q += 1;
        out += '<span class="ck-num">' + esc(text.slice(i, q)) + '</span>';
        i = q;
        continue;
      }
      out += esc(ch);
      i += 1;
    }
    el.innerHTML = out;
    el.dataset.ckHighlighted = '1';
  }

  function renderStyledContent(filePath, content) {
    var ext = (typeof window.fileExt === 'function') ? window.fileExt(filePath) : '';
    if (!ext) {
      var dot = String(filePath || '').lastIndexOf('.');
      ext = dot >= 0 ? String(filePath).slice(dot).toLowerCase() : '';
    }
    var pc0 = document.getElementById('previewCode');
    if (pc0) delete pc0.dataset.ckHighlighted;
    var isMd = (typeof MD_EXTS !== 'undefined' && MD_EXTS.has(ext)) || ext === '.md' || ext === '.markdown' || ext === '.mdx';
    if (isMd && typeof window.renderMarkdownPreviewContent === 'function') {
      window.renderMarkdownPreviewContent({ content: content });
      return;
    }
    if (ext === '.csv' && typeof window.renderCsvPreviewContent === 'function') {
      if (window.renderCsvPreviewContent(filePath, content)) return;
    }
    // Render code directly instead of delegating to the legacy renderer: that one awaits the
    // Prism CDN autoloader, so the pane sat as raw text for seconds before styling (or stayed
    // unstyled forever when the CDN is blocked). This path is synchronous — styled on paint.
    if (typeof window.showPreview === 'function') window.showPreview('code');
    var pc = document.getElementById('previewCode');
    if (pc) {
      pc.textContent = content || '';
      pc.scrollTop = 0;
      if (content && content.length <= 400000) cockpitFallbackHighlight(pc, content);
      return;
    }
    if (typeof window.showPreview === 'function') window.showPreview('code');
    var pc2 = document.getElementById('previewCode');
    if (pc2) {
      pc2.textContent = content;
      cockpitFallbackHighlight(pc2, content || '');
    }
  }


  window.cockpitSetPreviewMode = function(mode) {
    if (previewModeState.content === null) return;
    // Don't throw away in-progress typing when the operator flips tabs.
    if (window.cockpitEditor && typeof window.cockpitEditor.isEditable === 'function'
        && window.cockpitEditor.isEditable()
        && typeof window.cockpitEditor.getContent === 'function') {
      previewModeState.content = window.cockpitEditor.getContent();
    }
    previewModeState.mode = mode === 'raw' ? 'raw' : 'styled';
    syncPreviewModeTabsUi();
    if (previewModeState.mode === 'raw') {
      if (typeof window.showPreview === 'function') window.showPreview('code');
      var pc = document.getElementById('previewCode');
      if (pc) pc.textContent = previewModeState.content;
    } else {
      previewModeState.suppressCapture = true;
      try {
        renderStyledContent(previewModeState.path, previewModeState.content);
      } finally {
        previewModeState.suppressCapture = false;
      }
    }
  };

  // Source/config/log files must be PREVIEWED, never handed to the browser as a download.
  // Chrome downloads text/x-python, application/json, etc.; the old code let DOWNLOAD_EXTS
  // win for those, so clicking a session edit saved a file instead of showing it.
  var TEXT_PREVIEW_EXTS = new Set(['.py','.pyi','.pyx','.js','.mjs','.cjs','.mts','.cts','.ts','.tsx','.jsx','.json','.jsonl','.ndjson','.json5','.jsonc','.webmanifest','.md','.markdown','.mdx','.txt','.rst','.adoc','.org','.log','.out','.err','.trace','.yml','.yaml','.toml','.ini','.cfg','.conf','.config','.properties','.plist','.env','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd','.sql','.rb','.php','.go','.rs','.java','.kt','.kts','.scala','.groovy','.gradle','.clj','.cljs','.c','.h','.cc','.cpp','.hpp','.cs','.swift','.lua','.pl','.pm','.r','.jl','.dart','.ex','.exs','.erl','.fs','.fsx','.vb','.m','.mm','.zig','.nim','.v','.sv','.asm','.s','.sol','.tf','.tfvars','.hcl','.nix','.bzl','.bazel','.cmake','.mk','.proto','.graphql','.gql','.vue','.svelte','.astro','.html','.htm','.xml','.svg','.css','.scss','.sass','.less','.ejs','.hbs','.mustache','.twig','.j2','.jinja','.jinja2','.erb','.haml','.slim','.tex','.bib','.csv','.tsv','.patch','.diff','.gitignore','.gitattributes','.dockerfile','.editorconfig','.lock','.har','.http','.rest','.service','.rules','.ovpn','.pem','.crt','.key','.pub','.csproj','.sln']);

  async function openExternalFile(absPath) {
    var st = getLegacyState();
    var sid = st && st.session ? st.session.session_id : '';
    if (!sid || !absPath) return;
    var ext = (typeof window.fileExt === 'function') ? window.fileExt(absPath) : '';
    if (!ext) {
      var dot = String(absPath || '').lastIndexOf('.');
      ext = dot >= 0 ? String(absPath).slice(dot).toLowerCase() : '';
    }
    var rawUrl = '/api/cockpit/fs/raw?session_id=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(absPath);

    if (!TEXT_PREVIEW_EXTS.has(ext) && typeof DOWNLOAD_EXTS !== 'undefined' && DOWNLOAD_EXTS.has(ext)) {
      var dl = document.createElement('a');
      dl.href = rawUrl + '&download=1';
      dl.download = absPath.split(/[\\/]/).pop() || 'download';
      document.body.appendChild(dl);
      dl.click();
      setTimeout(function() { document.body.removeChild(dl); }, 100);
      return;
    }

    var isImg = typeof IMAGE_EXTS !== 'undefined' && IMAGE_EXTS.has(ext);
    var isPdf = typeof PDF_EXTS !== 'undefined' && PDF_EXTS.has(ext) || ext === '.pdf';
    var isAudio = typeof AUDIO_EXTS !== 'undefined' && AUDIO_EXTS.has(ext);
    var isVideo = typeof VIDEO_EXTS !== 'undefined' && VIDEO_EXTS.has(ext);
    var isHtml = typeof HTML_EXTS !== 'undefined' && HTML_EXTS.has(ext);

    if (isImg || isPdf || isAudio || isVideo || isHtml) {
      wsNav.externalFile = absPath;
      var pa = document.getElementById('previewArea');
      var pt = document.getElementById('previewPathText');
      var pb = document.getElementById('previewBadge');
      var ft = document.getElementById('fileTree');
      if (pt) pt.textContent = absPath;
      if (pb) pb.textContent = ext.replace('.', '').toUpperCase() || 'external';
      renderExternalBreadcrumb(wsNav.externalDir || absPath);
      if (ft) ft.style.display = 'none';
      if (pa) pa.classList.add('visible');
      previewModeState.path = absPath;
      previewModeState.content = null;
      previewModeState.mode = 'styled';
      syncPreviewModeTabsUi();

      if (isPdf) {
        if (typeof window.showPreview === 'function') window.showPreview('pdf');
        var frame = document.getElementById('previewPdfFrame');
        if (frame) {
          frame.title = 'PDF preview: ' + (absPath.split(/[\\/]/).pop() || absPath);
          frame.src = rawUrl;
        }
      } else if (isImg) {
        if (typeof window.showPreview === 'function') window.showPreview('image');
        var img = document.getElementById('previewImg');
        if (img) {
          img.alt = absPath;
          img.src = rawUrl;
        }
      } else if (isAudio || isVideo) {
        var mode = isVideo ? 'video' : 'audio';
        if (typeof window.showPreview === 'function') window.showPreview(mode);
        var wrap = document.getElementById('previewMediaWrap');
        if (wrap) {
          wrap.innerHTML = '';
          var media = document.createElement(mode);
          media.src = rawUrl;
          media.controls = true;
          media.preload = 'metadata';
          media.style.maxWidth = '100%';
          wrap.appendChild(media);
        }
      } else if (isHtml) {
        if (typeof window.showPreview === 'function') window.showPreview('html');
        var htmlFrame = document.getElementById('previewHtmlIframe');
        if (htmlFrame) {
          htmlFrame.src = '';
          htmlFrame.src = rawUrl;
        }
      }
      syncWsNavButtons();
      return;
    }

    try {
      var resp = await fetch('/api/cockpit/fs/read?session_id=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(absPath), { credentials: 'include' });
      if (!resp.ok) return;
      var data = await resp.json();
      if (data && data.binary) {
        // Never render mojibake for a binary file — say what it is and offer the raw view.
        var pab = document.getElementById('previewArea');
        var ptb = document.getElementById('previewPathText');
        var pbb = document.getElementById('previewBadge');
        var ftb = document.getElementById('fileTree');
        var sizeKb = Math.max(1, Math.round((data.size || 0) / 1024));
        if (ptb) ptb.textContent = absPath;
        if (pbb) pbb.textContent = 'binary';
        if (ftb) ftb.style.display = 'none';
        if (pab) pab.classList.add('visible');
        if (typeof window.showPreview === 'function') window.showPreview('code');
        var pcb = document.getElementById('previewCode');
        if (pcb) {
          pcb.textContent = 'Binary file (' + sizeKb + ' KB) — not shown as text. Use the Raw tab to open or download it.';
        }
        previewModeState.path = absPath;
        previewModeState.content = '';
        previewModeState.mode = 'styled';
        syncPreviewModeTabsUi();
        return;
      }
      var resolvedPath = data.path || absPath;
      var content = data.content || '';
      wsNav.externalFile = resolvedPath;
      var pa = document.getElementById('previewArea');
      var pt = document.getElementById('previewPathText');
      var pb = document.getElementById('previewBadge');
      var ft = document.getElementById('fileTree');
      if (pt) pt.textContent = resolvedPath;
      if (pb) pb.textContent = data.truncated ? 'truncated' : 'external';
      if (typeof window.renderFileBreadcrumb === 'function') {
        renderExternalBreadcrumb(wsNav.externalDir || resolvedPath);
      }
      if (ft) ft.style.display = 'none';
      if (pa) pa.classList.add('visible');
      previewModeState.path = resolvedPath;
      previewModeState.content = content;
      previewModeState.mode = 'styled';
      syncPreviewModeTabsUi();
      previewModeState.suppressCapture = true;
      try {
        renderStyledContent(resolvedPath, content);
      } finally {
        previewModeState.suppressCapture = false;
      }
      syncWsNavButtons();
    } catch (_) {}
  }

  async function loadExternalDir(dirPath) {
    var st = getLegacyState();
    var sid = st && st.session ? st.session.session_id : '';
    if (!sid) return;
    try {
      var url = '/api/cockpit/fs/list?session_id=' + encodeURIComponent(sid) + (dirPath ? ('&dir=' + encodeURIComponent(dirPath)) : '');
      var resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return;
      var data = await resp.json();
      wsNav.externalDir = data.path;
      wsNav.externalParent = data.parent || null;
      wsNav.externalFile = null;
      if (typeof window.clearPreview === 'function') {
        try { window.clearPreview({ keepPanelOpen: true }); } catch (_) {}
      }
      renderExternalBreadcrumb(data.path);
      var ft = document.getElementById('fileTree');
      var empty = document.getElementById('wsEmptyState');
      if (empty) empty.style.display = 'none';
      if (ft) {
        ft.style.display = '';
        ft.innerHTML = '';
        var frag = document.createDocumentFragment();
        (data.entries || []).forEach(function(entry) {
          var row = document.createElement('div');
          row.className = 'file-item';
          row.title = entry.path;
          var icon = document.createElement('span');
          icon.className = 'file-icon';
          icon.textContent = entry.type === 'dir' ? '▸ ' : '  ';
          var name = document.createElement('span');
          name.className = 'file-name';
          name.textContent = entry.name + (entry.type === 'dir' ? '/' : '');
          row.appendChild(icon);
          row.appendChild(name);
          row.onclick = function() {
            if (!wsNav.suppressClear) wsNav.forwardStack.length = 0;
            if (entry.type === 'dir') {
              void loadExternalDir(entry.path);
            } else {
              void openExternalFile(entry.path);
            }
          };
          frag.appendChild(row);
        });
        ft.appendChild(frag);
      }
      syncWsNavButtons();
    } catch (_) {}
  }

  window.cockpitWsBack = async function() {
    var st = getLegacyState();
    if (!st || !st.session) return;
    var cur = currentLocationEntry();
    wsNav.forwardStack.push(cur);
    if (wsNav.forwardStack.length > 50) wsNav.forwardStack.shift();

    if (wsNav.externalFile) {
      wsNav.externalFile = null;
      var ft = document.getElementById('fileTree');
      if (ft) ft.style.display = '';
      if (typeof window.clearPreview === 'function') window.clearPreview({ keepPanelOpen: true });
      syncWsNavButtons();
      return;
    }
    if (isPreviewOpen()) {
      if (typeof window.clearPreview === 'function') window.clearPreview({ keepPanelOpen: true });
      syncWsNavButtons();
      return;
    }
    if (wsNav.externalDir) {
      if (wsNav.externalParent) {
        await loadExternalDir(wsNav.externalParent);
      }
      syncWsNavButtons();
      return;
    }
    if (st.currentDir && st.currentDir !== '.') {
      var parts = String(st.currentDir).split('/').filter(Boolean);
      parts.pop();
      wsNav.suppressClear = true;
      try {
        if (typeof window.loadDir === 'function') await window.loadDir(parts.length ? parts.join('/') : '.');
      } finally {
        wsNav.suppressClear = false;
      }
      syncWsNavButtons();
      return;
    }
    // At workspace root: step outside workspace into its parent directory
    try {
      var resp = await fetch('/api/cockpit/fs/list?session_id=' + encodeURIComponent(st.session.session_id), { credentials: 'include' });
      if (!resp.ok) return;
      var rootData = await resp.json();
      if (rootData.parent) {
        await loadExternalDir(rootData.parent);
      }
    } catch (_) {}
    syncWsNavButtons();
  };

  window.cockpitWsHome = async function() {
    var st = getLegacyState();
    if (!st || !st.session) return;
    var cur = currentLocationEntry();
    if (cur.mode !== 'ws-dir' || cur.path !== '.') {
      wsNav.forwardStack.push(cur);
      if (wsNav.forwardStack.length > 50) wsNav.forwardStack.shift();
    }
    wsNav.externalDir = null;
    wsNav.externalParent = null;
    wsNav.externalFile = null;
    var ft = document.getElementById('fileTree');
    if (ft) ft.style.display = '';
    if (typeof window.clearPreview === 'function') window.clearPreview({ keepPanelOpen: true });
    wsNav.suppressClear = true;
    try {
      if (typeof window.loadDir === 'function') await window.loadDir('.');
    } finally {
      wsNav.suppressClear = false;
    }
    syncWsNavButtons();
  };

  window.cockpitWsForward = async function() {
    var next = wsNav.forwardStack.pop();
    if (!next) {
      syncWsNavButtons();
      return;
    }
    wsNav.suppressClear = true;
    try {
      if (next.mode === 'ext-dir') {
        await loadExternalDir(next.path);
      } else if (next.mode === 'ext-file') {
        if (next.dir) await loadExternalDir(next.dir);
        await openExternalFile(next.path);
      } else if (next.mode === 'ws-file') {
        wsNav.externalDir = null;
        wsNav.externalParent = null;
        wsNav.externalFile = null;
        if (typeof window.openFile === 'function') await window.openFile(next.path);
      } else {
        wsNav.externalDir = null;
        wsNav.externalParent = null;
        wsNav.externalFile = null;
        if (typeof window.clearPreview === 'function') window.clearPreview({ keepPanelOpen: true });
        if (typeof window.loadDir === 'function') await window.loadDir(next.path || '.');
      }
    } finally {
      wsNav.suppressClear = false;
    }
    syncWsNavButtons();
  };

  function applyExtraTabUi(tab) {
    var panel = document.querySelector('aside.rightpanel');
    var extraRoot = document.getElementById('cockpit-extra-tabs-root');
    var isExtra = Boolean(tab && EXTRA_TABS[tab]);
    activeExtraTab = isExtra ? tab : null;

    Object.keys(EXTRA_TAB_BTN_IDS).forEach(function(k) {
      var btn = document.getElementById(EXTRA_TAB_BTN_IDS[k]);
      if (btn) {
        btn.classList.toggle('active', k === activeExtraTab);
        btn.setAttribute('aria-selected', k === activeExtraTab ? 'true' : 'false');
      }
    });

    if (isExtra) {
      if (panel) panel.dataset.activeTab = activeExtraTab;
      NATIVE_TAB_BTN_IDS.forEach(function(id) {
        var btn = document.getElementById(id);
        if (btn) {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
        }
      });
      var artifacts = document.getElementById('workspaceArtifacts');
      if (artifacts) artifacts.hidden = true;
      var todosPanel = document.getElementById('workspaceTodosPanel');
      if (todosPanel) todosPanel.hidden = true;
      if (extraRoot) extraRoot.hidden = false;
    } else {
      if (extraRoot) extraRoot.hidden = true;
    }

    var b = window.__HERMES_PANEL_BRIDGE__;
    if (b) {
      b.openTab(activeExtraTab);
    } else {
      window.__HERMES_PENDING_BRIDGE_STATE__ = Object.assign(
        window.__HERMES_PENDING_BRIDGE_STATE__ || {},
        { activeTab: activeExtraTab }
      );
    }
  }

  function installRuntimeHooks() {
    // 3. Guard renderMessages against re-entrancy loops during measurement callbacks
    if (typeof window.renderMessages === 'function' && !window.__HERMES_RENDER_GUARDED__) {
      window.__HERMES_RENDER_GUARDED__ = true;
      var origRender = window.renderMessages;
      var inRender = false;
      var pendingOptions = null;
      var rafPending = false;
      window.renderMessages = function(options) {
        if (inRender) {
          pendingOptions = options || pendingOptions || { preserveScroll: true };
          if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(function() {
              rafPending = false;
              var opts = pendingOptions;
              pendingOptions = null;
              if (opts !== null) window.renderMessages(opts);
            });
          }
          return;
        }
        inRender = true;
        var scroller = document.getElementById('messages') || document.querySelector('.chat-messages');
        var keepScroll = Boolean(options && options.preserveScroll && scroller);
        var prevTop = keepScroll ? scroller.scrollTop : 0;
        var prevBottomDist = keepScroll ? (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : 0;
        try {
          return origRender.apply(this, arguments);
        } finally {
          inRender = false;
          if (keepScroll && scroller && prevBottomDist > 40) {
            scroller.scrollTop = prevTop;
          }
        }
      };
    }

    // 3b. Global Prism guard so oversized/minified code blocks inside chat messages never freeze the UI
    if (typeof window.Prism !== 'undefined' && typeof window.Prism.highlightElement === 'function' && !window.Prism.highlightElement.__cockpitGuarded) {
      var origPrism = window.Prism.highlightElement;
      window.Prism.highlightElement = function(el) {
        if (el && typeof el.textContent === 'string') {
          var txt = el.textContent;
          var nl = txt.indexOf('\\n');
          var firstLen = nl === -1 ? txt.length : nl;
          if (txt.length > 65536 || firstLen > 8192) return;
        }
        return origPrism.apply(this, arguments);
      };
      window.Prism.highlightElement.__cockpitGuarded = true;
    }

    // 4. Bridge Hermes WebUI session & native workspace tab switcher to CMD/Browser/Findings tabs
    if (typeof window.switchWorkspacePanelTab === 'function' && !window.switchWorkspacePanelTab.__ohBridged) {
      var origSwitchTab = window.switchWorkspacePanelTab;
      window.switchWorkspacePanelTab = function(tab) {
        if (tab && EXTRA_TABS[tab]) {
          applyExtraTabUi(tab);
          syncBridgeSession();
          return;
        }
        applyExtraTabUi(null);
        return origSwitchTab.apply(this, arguments);
      };
      window.switchWorkspacePanelTab.__ohBridged = true;
    }

    if (typeof window.syncTopbar === 'function' && !window.syncTopbar.__ohBridged) {
      var origSyncTopbar = window.syncTopbar;
      window.syncTopbar = function() {
        var res = origSyncTopbar.apply(this, arguments);
        syncBridgeSession();
        return res;
      };
      window.syncTopbar.__ohBridged = true;
    }

    if (typeof window.loadSession === 'function' && !window.loadSession.__ohBridged) {
      var origLoadSession = window.loadSession;
      window.loadSession = async function(sid) {
        if (window.__HERMES_PANEL_BRIDGE__ && sid) {
          window.__HERMES_PANEL_BRIDGE__.setSession({ sessionId: sid });
        }
        var res = await origLoadSession.apply(this, arguments);
        syncBridgeSession();
        return res;
      };
      window.loadSession.__ohBridged = true;
    }

    if (typeof window.loadDir === 'function' && !window.loadDir.__wsNavBridged) {
      var origLoadDir = window.loadDir;
      window.loadDir = async function(path) {
        wsNav.externalDir = null;
        wsNav.externalParent = null;
        wsNav.externalFile = null;
        if (!wsNav.suppressClear) wsNav.forwardStack.length = 0;
        var res = await origLoadDir.apply(this, arguments);
        syncWsNavButtons();
        return res;
      };
      window.loadDir.__wsNavBridged = true;
    }

    if (typeof window.openFile === 'function' && !window.openFile.__wsNavBridged) {
      var origOpenFile = window.openFile;
      window.openFile = async function(path) {
        wsNav.externalFile = null;
        if (!wsNav.suppressClear) wsNav.forwardStack.length = 0;
        previewModeState.path = path || '';
        previewModeState.content = null;
        previewModeState.mode = 'styled';
        syncPreviewModeTabsUi();
        var res = await origOpenFile.apply(this, arguments);
        syncWsNavButtons();
        return res;
      };
      window.openFile.__wsNavBridged = true;
    }

    if (typeof window.renderMarkdownPreviewContent === 'function' && !window.renderMarkdownPreviewContent.__pmBridged) {
      var origRenderMd = window.renderMarkdownPreviewContent;
      window.renderMarkdownPreviewContent = function(data) {
        if (!previewModeState.suppressCapture && data && typeof data.content === 'string') {
          previewModeState.path = (typeof _previewCurrentPath !== 'undefined' && _previewCurrentPath) || previewModeState.path;
          previewModeState.content = data.content;
          previewModeState.mode = 'styled';
          syncPreviewModeTabsUi();
        }
        return origRenderMd.apply(this, arguments);
      };
      window.renderMarkdownPreviewContent.__pmBridged = true;
    }

    ['renderCodePreviewContent', 'renderCsvPreviewContent'].forEach(function(fnName) {
      var orig = window[fnName];
      if (typeof orig === 'function' && !orig.__pmBridged) {
        var wrapped = function(filePath, content) {
          if (!previewModeState.suppressCapture && typeof content === 'string') {
            previewModeState.path = filePath || previewModeState.path;
            previewModeState.content = content;
            previewModeState.mode = 'styled';
            syncPreviewModeTabsUi();
          }
          // Avoid main-thread freeze from Prism regex highlighting on large or minified files (>64 KB or >8 KB single line)
          if (fnName === 'renderCodePreviewContent' && typeof content === 'string') {
            var nl = content.indexOf('\\n');
            var firstLineLen = nl === -1 ? content.length : nl;
            if (content.length > 65536 || firstLineLen > 8192) {
              if (typeof window.showPreview === 'function') window.showPreview('code');
              var pre = document.getElementById('previewCode');
              if (pre) {
                pre.className = pre.className.replace(/\\blanguage-\\S+/g, '').replace(/\\s+/g, ' ').trim();
                pre.textContent = content;
              }
              return;
            }
          }
          return orig.apply(this, arguments);
        };
        wrapped.__pmBridged = true;
        window[fnName] = wrapped;
      }
    });

    if (typeof window.clearPreview === 'function' && !window.clearPreview.__pmBridged) {
      var origClearPreview = window.clearPreview;
      window.clearPreview = function() {
        previewModeState.path = '';
        previewModeState.content = null;
        previewModeState.mode = 'styled';
        syncPreviewModeTabsUi();
        return origClearPreview.apply(this, arguments);
      };
      window.clearPreview.__pmBridged = true;
    }

    syncBridgeSession();
    syncWsNavButtons();
    var syncToggleBtn = function() {
      var btn = document.getElementById('btnTitlebarRightPanel');
      if (!btn) return;
      var aside = document.querySelector('aside.rightpanel');
      var open = document.documentElement.dataset.workspacePanel === 'open' || Boolean(aside && aside.classList.contains('mobile-open'));
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    };
    ['openWorkspacePanel', 'closeWorkspacePanel', 'toggleWorkspacePanel', 'syncWorkspacePanelUI'].forEach(function(fnName) {
      var orig = window[fnName];
      if (typeof orig === 'function' && !orig.__rpBtnSynced) {
        var wrapped = function() {
          var res = orig.apply(this, arguments);
          syncToggleBtn();
          return res;
        };
        wrapped.__rpBtnSynced = true;
        window[fnName] = wrapped;
      }
    });
    syncToggleBtn();

    var st = getLegacyState();
    syncLiveWatcher(st && st.session ? (st.session.session_id || null) : null, st && st.session ? (st.session.workspace || '') : '');

    var ft = document.getElementById('fileTree');
    if (ft && !ft.__cockpitObserved && typeof MutationObserver !== 'undefined') {
      ft.__cockpitObserved = true;
      var ftTimer = null;
      new MutationObserver(function() {
        if (ftTimer) return;
        ftTimer = setTimeout(function() {
          ftTimer = null;
          seedSessionEdits();
          annotateFileTree();
          renderLiveEditsBar();
        }, 80);
      }).observe(ft, { childList: true, subtree: true });
    }
  }

  installRuntimeHooks();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installRuntimeHooks);
  }
  window.addEventListener('load', installRuntimeHooks);
})();
`;

  const min = transformSync(src, {
    loader: "js",
    minify: true,
    target: "es2020",
  });
  const bridgeFileName = `hermes-perf-bridge-${shortHash(min.code)}.js`;
  fs.writeFileSync(path.join(OUT_DIR, bridgeFileName), min.code, "utf8");
  return { bridgeFileName, bytes: Buffer.byteLength(min.code, "utf8") };
}

/**
 * Transform static/index.html into static/v2/index.html preserving CSRF/config tokens
 * while keeping Hermes's native <aside class="rightpanel"> + extra tabs.
 */
function findBuiltPanelAssets() {
  const assetsDir = path.join(OUT_DIR, "assets");
  const files = fs.readdirSync(assetsDir);
  const panelJs = files.find((f) => /^panel-[^.]+\.js$/.test(f));
  const panelCss = files.find((f) => /^panel-[^.]+\.css$/.test(f)) || files.find((f) => /^right-panel-entry-[^.]+\.css$/.test(f));
  if (!panelJs) {
    throw new Error("Could not find hashed panel-*.js in static/v2/assets/");
  }
  return { panelJs, panelCss };
}

function buildIndexHtml({ coreFileName, cssFileName, legacyHashes, bridgeFileName }) {
  let html = fs.readFileSync(path.join(STATIC_DIR, "index.html"), "utf8");
  const { panelJs, panelCss } = findBuiltPanelAssets();

  // 0. Keep <base href> pointing to app root (e.g. '/') on /v2 and /v2/session/<id>
  const baseHrefRegex = /<script>\(function\(\)\{var path=location\.pathname,marker='\/session\/',[\s\S]*?<\/script>/;
  if (!baseHrefRegex.test(html)) {
    throw new Error("Could not find <base href> script in static/index.html");
  }
  html = html.replace(
    baseHrefRegex,
    `<script>(function(){var path=location.pathname,v2=path.indexOf('/v2'),marker='/session/',i=path.indexOf(marker),p='/';if(v2>=0&&(path.slice(v2)==='/v2'||path.slice(v2,v2+4)==='/v2/')){p=path.slice(0,v2+1)||'/';}else if(i>=0){p=path.slice(0,i+1)||'/';}else{p=path.endsWith('/')?path:(path.replace(/\\/[^\\/]*$/,'/')||'/');}document.write('<base href="'+location.origin+p+'">');})()</script>`
  );

  // 1. Drop external xterm CDN stylesheet + scripts (bundled locally in CMD tab)
  html = html.replace(/<link[^>]*cdn\.jsdelivr\.net\/npm\/xterm[^>]*>\s*/gi, "");
  html = html.replace(/<script[^>]*cdn\.jsdelivr\.net\/npm\/xterm[^>]*><\/script>\s*/gi, "");

  // 2. Remove legacy sw.js registration on /v2
  html = html.replace(
    /<!-- PWA service worker registration -->[\s\S]*?<\/script>\s*/i,
    ""
  );

  // 3. Point stylesheet to minified v2 CSS + load hashed panel CSS + extra-tab layout rules
  const panelCssTag = panelCss
    ? `\n<link rel="stylesheet" href="static/v2/assets/${panelCss}">`
    : "";
  const extraTabsStyle = `\n<style id="cockpit-extra-tabs-style">.app-titlebar{justify-content:space-between!important;padding:0 12px;gap:8px;}.app-titlebar-inner{justify-content:flex-start!important;flex:1 1 auto;min-width:0;}.app-titlebar-spacer{display:none!important;}.app-titlebar-rightpanel-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;flex-shrink:0;transition:background .15s,color .15s,border-color .15s;-webkit-app-region:no-drag;}.app-titlebar-rightpanel-btn:hover{background:var(--hover-bg);color:var(--text);}.app-titlebar-rightpanel-btn[aria-pressed="true"],html[data-workspace-panel="open"] .app-titlebar-rightpanel-btn{color:var(--accent-text,var(--text));background:var(--accent-bg,var(--surface-subtle));border-color:var(--border2,var(--border));}.workspace-panel-tabs{flex-wrap:wrap;}.workspace-panel-tab{white-space:nowrap;flex:1 0 auto;padding:4px 7px;font-size:11.5px;}.rightpanel:not([data-active-tab="files"]) .panel-header,.rightpanel:not([data-active-tab="files"]) .cockpit-live-edits{display:none!important;}.rightpanel[data-active-tab="cmd"] .breadcrumb-bar,.rightpanel[data-active-tab="cmd"] .file-tree,.rightpanel[data-active-tab="cmd"] #wsEmptyState,.rightpanel[data-active-tab="cmd"] .workspace-artifacts,.rightpanel[data-active-tab="cmd"] .workspace-todos,.rightpanel[data-active-tab="cmd"] .preview-area,.rightpanel[data-active-tab="browser"] .breadcrumb-bar,.rightpanel[data-active-tab="browser"] .file-tree,.rightpanel[data-active-tab="browser"] #wsEmptyState,.rightpanel[data-active-tab="browser"] .workspace-artifacts,.rightpanel[data-active-tab="browser"] .workspace-todos,.rightpanel[data-active-tab="browser"] .preview-area,.rightpanel[data-active-tab="findings"] .breadcrumb-bar,.rightpanel[data-active-tab="findings"] .file-tree,.rightpanel[data-active-tab="findings"] #wsEmptyState,.rightpanel[data-active-tab="findings"] .workspace-artifacts,.rightpanel[data-active-tab="findings"] .workspace-todos,.rightpanel[data-active-tab="findings"] .preview-area,.rightpanel[data-active-tab="proxy"] .breadcrumb-bar,.rightpanel[data-active-tab="proxy"] .file-tree,.rightpanel[data-active-tab="proxy"] #wsEmptyState,.rightpanel[data-active-tab="proxy"] .workspace-artifacts,.rightpanel[data-active-tab="proxy"] .workspace-todos,.rightpanel[data-active-tab="proxy"] .preview-area{display:none!important;}.rightpanel[data-active-tab="cmd"] #cockpit-extra-tabs-root,.rightpanel[data-active-tab="browser"] #cockpit-extra-tabs-root,.rightpanel[data-active-tab="findings"] #cockpit-extra-tabs-root,.rightpanel[data-active-tab="proxy"] #cockpit-extra-tabs-root{display:flex!important;}.rightpanel:not([data-active-tab="cmd"]):not([data-active-tab="browser"]):not([data-active-tab="findings"]):not([data-active-tab="proxy"]) #cockpit-extra-tabs-root{display:none!important;}.cockpit-live-edits{border-bottom:1px solid var(--border);background:var(--surface-subtle);flex-shrink:0;}.cockpit-live-edits-hdr{width:100%;display:flex;align-items:center;gap:6px;padding:6px 12px;border:0;background:transparent;color:var(--text);font-size:11px;font-weight:600;cursor:pointer;text-align:left;}.cockpit-live-edits-hdr:hover{background:var(--hover-bg);}.cockpit-live-dot{width:7px;height:7px;border-radius:50%;background:#10b981;flex-shrink:0;box-shadow:0 0 0 2px rgba(16,185,129,.22);}.cockpit-live-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.cockpit-live-count{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--hover-bg);color:var(--muted);font-family:var(--font-mono);}.cockpit-live-chev{color:var(--muted);font-size:10px;}.cockpit-live-edits-list{max-height:132px;overflow-y:auto;border-top:1px solid var(--border);padding:4px;}.cockpit-live-edit-row{width:100%;display:flex;align-items:center;gap:6px;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:var(--text);font-size:11px;cursor:pointer;text-align:left;}.cockpit-live-edit-row:hover{background:var(--hover-bg);}.cockpit-live-edit-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);}.cockpit-file-badge{margin-left:auto;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;font-family:var(--font-mono);letter-spacing:.03em;flex-shrink:0;}.cockpit-file-badge--new{background:rgba(16,185,129,.16);color:#10b981;}.cockpit-file-badge--mod{background:rgba(245,158,11,.16);color:#f59e0b;}.cockpit-file-badge--del{background:rgba(239,68,68,.16);color:#ef4444;}.cockpit-preview-mode-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--surface-subtle);flex-shrink:0;}.cockpit-preview-mode-tabs[hidden]{display:none!important;}.cockpit-preview-mode-tab{border:0;background:transparent;color:var(--muted);font-size:11px;font-weight:500;padding:2px 8px;border-radius:4px;cursor:pointer;line-height:1.3;}.cockpit-preview-mode-tab:hover{color:var(--text);}.cockpit-preview-mode-tab.active{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.2);}#messages{overflow-anchor:auto;}#messages>.msg,#messages>.message,.chat-messages>.msg,.chat-messages>.message{content-visibility:auto;contain-intrinsic-size:auto 120px;}.app-titlebar-telemetry{display:inline-flex;align-items:center;gap:6px;margin-right:8px;flex-shrink:0;-webkit-app-region:no-drag;}.cktel{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border:1px solid var(--border,#333);border-radius:999px;background:var(--surface-subtle,rgba(255,255,255,.05));font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;line-height:1.4;color:var(--muted,#8b8b8b);white-space:nowrap;}.cktel-k{font-weight:600;letter-spacing:.04em;opacity:.75;}.cktel-v{color:var(--text,inherit);font-variant-numeric:tabular-nums;}.cktel[data-level="warn"] .cktel-v{color:#f59e0b;}.cktel[data-level="hot"] .cktel-v{color:#ef4444;}@media(max-width:700px){.app-titlebar-telemetry{gap:3px;margin-right:4px;}.cktel{padding:1px 5px;font-size:9.5px;}.cktel-k{display:none;}}.ck-kw{color:#c792ea;}.ck-str{color:#c3e88d;}.ck-cmt{color:#7f8c98;font-style:italic;}.ck-num{color:#f78c6c;}#messages{overflow-anchor:none!important;}#btnEditFile{display:none!important;}.ck-undo{position:absolute;top:2px;right:6px;z-index:5;opacity:0;transition:opacity .12s;font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border,#333);background:var(--surface-subtle,rgba(255,255,255,.06));color:var(--muted,#9aa4ae);cursor:pointer;}.msg-row[data-role="user"]{position:relative;}.msg-row[data-role="user"]:hover .ck-undo{opacity:1;}.ck-undo:hover{color:#f87171;border-color:rgba(248,113,113,.5);}.ck-narr{margin:6px 0;padding:2px 0 2px 8px;border-left:2px solid rgba(52,211,153,.45);white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.55;color:var(--text-secondary,#b9c2cc);}</style>`;
  html = html.replace(
    '<link rel="stylesheet" href="static/style.css?v=__WEBUI_VERSION__">',
    `<link rel="stylesheet" href="static/v2/${cssFileName}?v=__WEBUI_VERSION__">${panelCssTag}${extraTabsStyle}`
  );

  // 3b. Add right-panel toggle button to the right side of the top header
  const titlebarEndRegex = /(<header class="app-titlebar"[^>]*>[\s\S]*?)(<\/header>)/i;
  if (!titlebarEndRegex.test(html)) {
    throw new Error("Could not find <header class=\"app-titlebar\"> in static/index.html");
  }
  html = html.replace(
    titlebarEndRegex,
    `$1  <span id="cockpitTelemetry" class="app-titlebar-telemetry" role="status" aria-label="Live VPS usage" title="Live VPS usage — CPU / RAM / disk"><span class="cktel" id="cktelCpu"><span class="cktel-k">CPU</span><span class="cktel-v">–</span></span><span class="cktel" id="cktelRam"><span class="cktel-k">RAM</span><span class="cktel-v">–</span></span><span class="cktel" id="cktelDisk"><span class="cktel-k">DISK</span><span class="cktel-v">–</span></span></span>
  <button class="app-titlebar-rightpanel-btn has-tooltip has-tooltip--left" id="btnTitlebarRightPanel" type="button" onclick="toggleWorkspacePanel()" data-tooltip="Toggle right panel" aria-label="Toggle right panel" aria-pressed="false" title="Show/hide right panel">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
  </button>
$2`
  );

  // 4. Move .workspace-panel-tabs above .panel-header so Workspace header/actions only live in Files tab,
  //    add CMD, Browser, Findings, HTTP Proxy tabs, and add live-edits bar + React mount container.
  const tabsBarRegex = /<div class="workspace-panel-tabs"[^>]*>[\s\S]*?<\/div>/i;
  const tabsBarMatch = tabsBarRegex.exec(html);
  if (!tabsBarMatch) {
    throw new Error("Could not find .workspace-panel-tabs in static/index.html");
  }
  const enhancedTabsBar = tabsBarMatch[0]
    .replace(
      /(<button[^>]*id="workspaceFilesTab"[\s\S]*?<\/button>)/i,
      `$1
      <button class="workspace-panel-tab" id="workspaceCmdTab" type="button" onclick="switchWorkspacePanelTab('cmd')" role="tab" aria-selected="false">CMD</button>
      <button class="workspace-panel-tab" id="workspaceBrowserTab" type="button" onclick="switchWorkspacePanelTab('browser')" role="tab" aria-selected="false">Browser</button>
      <button class="workspace-panel-tab" id="workspaceProxyTab" type="button" onclick="switchWorkspacePanelTab('proxy')" role="tab" aria-selected="false">HTTP Proxy</button>`
    )
    .replace(
      /(<button[^>]*id="workspaceArtifactsTab"[\s\S]*?<\/button>)/i,
      `$1
      <button class="workspace-panel-tab" id="workspaceFindingsTab" type="button" onclick="switchWorkspacePanelTab('findings')" role="tab" aria-selected="false">Findings</button>`
    );
  html = html.replace(tabsBarMatch[0], "");
  html = html.replace(
    '<div class="resize-handle" id="rightpanelResize"></div>',
    `<div class="resize-handle" id="rightpanelResize"></div>\n    ${enhancedTabsBar}`
  );
  html = html.replace(
    '<div class="file-tree" id="fileTree"></div>',
    '<div id="cockpitLiveEditsBar" class="cockpit-live-edits" hidden></div>\n    <div class="file-tree" id="fileTree"></div>'
  );
  // 4b. Replace #btnUpDir with Back (can exit workspace), Home (workspace root), Forward (previous visited)
  const upDirBtnRegex = /<button[^>]*id="btnUpDir"[\s\S]*?<\/button>/i;
  if (!upDirBtnRegex.test(html)) {
    throw new Error("Could not find #btnUpDir in static/index.html");
  }
  html = html.replace(
    upDirBtnRegex,
    `<button id="btnUpDir" hidden style="display:none!important" aria-hidden="true"></button>
        <button class="panel-icon-btn has-tooltip has-tooltip--bottom" id="btnWsBack" type="button" data-tooltip="Back / parent folder" aria-label="Back / parent folder" title="Back (can go outside workspace)" onclick="cockpitWsBack()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>
        <button class="panel-icon-btn has-tooltip has-tooltip--bottom" id="btnWsHome" type="button" data-tooltip="Workspace home" aria-label="Workspace home" title="Go to workspace directory" onclick="cockpitWsHome()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button>
        <button class="panel-icon-btn has-tooltip has-tooltip--bottom" id="btnWsForward" type="button" data-tooltip="Forward / previous visited" aria-label="Forward / previous visited" title="Go to previous visited file or folder" onclick="cockpitWsForward()" disabled><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>`
  );

  // 4c. Add [Styled | Raw] tabs on the right of #previewPath
  const previewPathRegex = /(<div class="preview-path" id="previewPath">[\s\S]*?)(<\/div>)/i;
  if (!previewPathRegex.test(html)) {
    throw new Error("Could not find #previewPath in static/index.html");
  }
  html = html.replace(
    previewPathRegex,
    `$1        <div id="cockpitPreviewModeTabs" class="cockpit-preview-mode-tabs" role="tablist" aria-label="Preview format" hidden>
          <button id="btnPreviewStyled" class="cockpit-preview-mode-tab active" type="button" role="tab" aria-selected="true" onclick="cockpitSetPreviewMode('styled')">Styled</button>
          <button id="btnPreviewRaw" class="cockpit-preview-mode-tab" type="button" role="tab" aria-selected="false" onclick="cockpitSetPreviewMode('raw')">Raw</button>
        </div>
      $2`
  );

  const rightPanelEndRegex = /(<aside class="rightpanel">[\s\S]*?)(<\/aside>)/i;
  if (!rightPanelEndRegex.test(html)) {
    throw new Error("Could not find <aside class=\"rightpanel\"> in static/index.html");
  }
  html = html.replace(
    rightPanelEndRegex,
    `$1  <div id="cockpit-extra-tabs-root" class="cockpit-extra-tabs-root" hidden style="flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden;"></div>
  $2`
  );

  // 5. Replace the 15 sequential unminified <script src="static/*.js" defer> tags
  //    with our split i18n-core + minified legacy scripts + perf bridge + OpenHands panel module
  const scriptBlockRegex =
    /<script src="static\/i18n\.js\?v=__WEBUI_VERSION__" defer><\/script>[\s\S]*?<script src="static\/outline\.js\?v=__WEBUI_VERSION__" defer><\/script>/i;
  if (!scriptBlockRegex.test(html)) {
    throw new Error("Could not find legacy script block in static/index.html");
  }
  const legacyTags = LEGACY_SCRIPTS_ORDER.map(
    (name) =>
      `<script src="static/v2/legacy/${name}?v=__WEBUI_VERSION__&h=${legacyHashes[name]}" defer></script>`
  ).join("\n");
  html = html.replace(
    scriptBlockRegex,
    `<script src="static/v2/${coreFileName}?v=__WEBUI_VERSION__" defer></script>
${legacyTags}
<script src="static/v2/${bridgeFileName}?v=__WEBUI_VERSION__" defer></script>
<script type="module" src="static/v2/assets/${panelJs}"></script>
<script>/* cockpit telemetry: live CPU / RAM / disk in the titlebar, left of the panel toggle */
(function(){function level(p){return p>=85?"hot":p>=70?"warn":"";}
function paint(id,pct){var el=document.getElementById(id);if(!el)return;var v=el.querySelector(".cktel-v");if(v)v.textContent=pct+"%";el.setAttribute("data-level",level(pct));el.title=id.replace("cktel","")+" "+pct+"%";}
function tick(){if(document.hidden)return;fetch("/api/system/health",{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d||d.available===false)return;var c=Math.round(((d.cpu||{}).percent)||0),m=Math.round(((d.memory||{}).percent)||0),k=Math.round(((d.disk||{}).percent)||0);paint("cktelCpu",c);paint("cktelRam",m);paint("cktelDisk",k);}).catch(function(){});}
setTimeout(tick,500);setInterval(tick,5000);document.addEventListener("visibilitychange",function(){if(!document.hidden)tick();});})();</script>
<script>/* cockpit: keep the transcript pinned while a reply streams. The legacy renderer
re-anchors mid-stream and yanks the viewport back up to the user's message; this
re-pins to the bottom on every mutation unless the operator scrolled up on purpose. */
(function(){var el=document.getElementById('messages');if(!el)return;var stick=true,raf=0;
function near(){return (el.scrollHeight-el.scrollTop-el.clientHeight)<160;}
function afterUser(){setTimeout(function(){stick=near();},160);}
['wheel','touchmove','keydown'].forEach(function(ev){el.addEventListener(ev,afterUser,{passive:true});});
function pin(){if(!stick||raf)return;raf=requestAnimationFrame(function(){raf=0;el.scrollTop=el.scrollHeight;});}
new MutationObserver(pin).observe(el,{childList:true,subtree:true,characterData:true});
el.scrollTop=el.scrollHeight;})();</script>
<script>/* cockpit: mirror agent narration inside the live "Processed" worklog.
   Mid-turn the legacy renderer hides assistant prose and shows only scene rows, so the
   operator goes blind between tool calls. Mirror each *superseded* hidden segment's text as
   a read-only row inside the worklog (idempotent, removed when its source disappears). The
   newest segment is skipped so the in-progress answer is never duplicated. */
(function(){
  var rows = new Map();
  function worklogList(){
    return document.querySelector('.live-worklog[data-live-worklog-shell="1"] .tool-worklog-list')
        || document.querySelector('.live-worklog .tool-worklog-list');
  }
  function settle(){
    var list = worklogList();
    var segs = document.querySelectorAll('.assistant-segment');
    if (!list) return;
    var alive = new Set();
    for (var i=0;i<segs.length;i++){
      if (i === segs.length-1) continue;
      var seg = segs[i];
      var t = (seg.textContent||'').trim();
      if (!t) continue;
      var hidden = seg.hidden || seg.getAttribute('aria-hidden')==='true'
        || (seg.style && seg.style.display==='none')
        || seg.classList.contains('assistant-segment-worklog-source');
      if (!hidden) continue;
      alive.add(seg);
      var row = rows.get(seg);
      if (!row || !row.parentNode){
        row = document.createElement('div');
        row.className = 'wl-reason ck-narr';
        row.setAttribute('data-ck-narration','1');
        list.appendChild(row);
        rows.set(seg, row);
      }
      if (row.textContent !== t) row.textContent = t;
    }
    rows.forEach(function(row, seg){
      if (!alive.has(seg) || !seg.isConnected){
        if (row.parentNode) row.parentNode.removeChild(row);
        rows.delete(seg);
      }
    });
  }
  var pending=0;
  function schedule(){ clearTimeout(pending); pending=setTimeout(settle,180); }
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,characterData:true});
  setInterval(settle,1500);
})();</script>
<script>/* cockpit: per-message rewind. Any user message can delete itself and everything
after it via /api/session/undo_to, which truncates the transcript server-side with the
same lock/watermark path as the native /undo command. */
(function(){
  function sid(){
    try{ var s=window.__HERMES_GET_S__&&window.__HERMES_GET_S__(); return s&&s.session?s.session.session_id:''; }catch(e){ return ''; }
  }
  function toast(m,kind){ if(typeof showToast==='function') showToast(m,3200,kind||'info'); }
  function decorate(){
    var rows=document.querySelectorAll('.msg-row[data-role="user"]:not([data-ck-undo])');
    for(var i=0;i<rows.length;i++){
      (function(row){
        row.setAttribute('data-ck-undo','1');
        var b=document.createElement('button');
        b.type='button'; b.className='ck-undo'; b.textContent='Undo';
        b.title='Delete this message and every message after it';
        b.addEventListener('click',function(ev){
          ev.preventDefault(); ev.stopPropagation();
          var idx=Number(row.getAttribute('data-msg-idx'));
          var s=sid();
          if(!s){ toast('No active session','error'); return; }
          if(!window.confirm('Rewind to this message? This permanently deletes this prompt and everything after it. Already-made file/system changes are NOT reverted.')) return;
          b.disabled=true; b.textContent='Undoing...';
          var cfg=window.__HERMES_CONFIG__||{}; var h={'Content-Type':'application/json'};
          if(cfg.csrfToken) h['X-CSRF-Token']=cfg.csrfToken;
          fetch('/api/session/undo_to',{method:'POST',credentials:'same-origin',headers:h,
            body:JSON.stringify({session_id:s,user_index:idx})})
            .then(function(r){ return r.json(); })
            .then(function(d){
              if(d&&d.ok){
                toast('Rewound - removed '+d.removed_count+' messages','success');
                try{ if(typeof loadSession==='function'){ loadSession(s); return; } }catch(e){}
                location.reload();
              } else {
                toast((d&&d.error)||'Undo failed','error');
                b.disabled=false; b.textContent='\u21b6 Undo';
              }
            })
            .catch(function(){ toast('Undo failed','error'); b.disabled=false; b.textContent='\u21b6 Undo'; });
        });
        row.appendChild(b);
      })(rows[i]);
    }
  }
  var t=0; function sched(){ clearTimeout(t); t=setTimeout(decorate,250); }
  new MutationObserver(sched).observe(document.body,{childList:true,subtree:true});
  setInterval(decorate,2000);
  decorate();
})();</script>`
  );

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html, "utf8");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const i18nStats = buildSplitI18n();
const legacyStats = buildLegacyAssets();
const bridgeInfo = buildPerfAndBridgeScript();
buildIndexHtml({
  coreFileName: i18nStats.coreFileName,
  cssFileName: legacyStats.cssFileName,
  legacyHashes: legacyStats.legacyHashes,
  bridgeFileName: bridgeInfo.bridgeFileName,
});

console.log(
  [
    `[v2-shell] i18n split: ${formatKB(i18nStats.originalBytes)} -> ${formatKB(i18nStats.coreBytes)} core (+ ${i18nStats.localeCount} lazy locales)`,
    `[v2-shell] legacy JS: ${formatKB(legacyStats.jsOriginal)} -> ${formatKB(legacyStats.jsMin)} minified`,
    `[v2-shell] legacy CSS: ${formatKB(legacyStats.cssOriginal)} -> ${formatKB(legacyStats.cssMin)} minified`,
    `[v2-shell] perf-bridge: ${formatKB(bridgeInfo.bytes)} (${bridgeInfo.bridgeFileName})`,
  ].join("\n")
);
