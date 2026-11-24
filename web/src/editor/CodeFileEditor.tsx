import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { c, cpp, csharp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";

export type EditorMode = "styled" | "edit" | "raw";

export interface CockpitEditorOpenOptions {
  path: string;
  content: string;
  mode?: EditorMode;
  readOnly?: boolean;
  onChange?: (content: string, dirty: boolean) => void;
  onSave?: (content: string) => void | Promise<void>;
}

export interface CockpitEditorBridge {
  open: (opts: CockpitEditorOpenOptions) => void;
  setMode: (mode: EditorMode) => void;
  getContent: () => string;
  setContent: (content: string, markSaved?: boolean) => void;
  isEditable: () => boolean;
  isDirty: () => boolean;
  markClean: (savedContent?: string) => void;
  focus: () => void;
  close: () => void;
}

declare global {
  interface Window {
    cockpitEditor?: CockpitEditorBridge;
  }
}

function getExtension(filePath: string): string {
  const name = (filePath || "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return ".dockerfile";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function languageForPath(filePath: string): Extension {
  const ext = getExtension(filePath);
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return javascript();
    case ".jsx":
      return javascript({ jsx: true });
    case ".ts":
    case ".mts":
    case ".cts":
      return javascript({ typescript: true });
    case ".tsx":
      return javascript({ jsx: true, typescript: true });
    case ".py":
    case ".pyi":
    case ".pyx":
      return python();
    case ".html":
    case ".htm":
    case ".xhtml":
    case ".vue":
    case ".svelte":
    case ".astro":
    case ".ejs":
    case ".hbs":
      return html();
    case ".css":
    case ".scss":
    case ".sass":
    case ".less":
      return css();
    case ".json":
    case ".jsonl":
    case ".ndjson":
    case ".json5":
    case ".jsonc":
    case ".webmanifest":
      return json();
    case ".md":
    case ".markdown":
    case ".mdx":
      return markdown();
    case ".yml":
    case ".yaml":
      return yaml();
    case ".sql":
      return sql();
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".fish":
      return StreamLanguage.define(shell);
    case ".ps1":
      return StreamLanguage.define(powerShell);
    case ".rs":
      return StreamLanguage.define(rust);
    case ".go":
      return StreamLanguage.define(go);
    case ".c":
    case ".h":
      return StreamLanguage.define(c);
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".hh":
      return StreamLanguage.define(cpp);
    case ".java":
      return StreamLanguage.define(java);
    case ".cs":
      return StreamLanguage.define(csharp);
    case ".kt":
    case ".kts":
      return StreamLanguage.define(kotlin);
    case ".rb":
      return StreamLanguage.define(ruby);
    case ".toml":
      return StreamLanguage.define(toml);
    case ".xml":
    case ".svg":
      return StreamLanguage.define(xml);
    case ".dockerfile":
      return StreamLanguage.define(dockerFile);
    case ".diff":
    case ".patch":
      return StreamLanguage.define(diff);
    case ".ini":
    case ".cfg":
    case ".conf":
    case ".properties":
    case ".env":
      return StreamLanguage.define(properties);
    default:
      return [];
  }
}

const initialThemeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword], color: "#c792ea" },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], color: "#c3e88d" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#f78c6c" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "#7f8c98", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#82aaff" },
  { tag: [tags.tagName, tags.typeName, tags.className], color: "#f07178" },
  { tag: [tags.propertyName, tags.attributeName], color: "#ffcb6b" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: "#89ddff" },
  { tag: [tags.regexp, tags.escape], color: "#c3e88d" },
]);

function buildBaseTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      width: "100%",
      backgroundColor: "var(--code-bg, transparent)",
      color: "var(--pre-text, var(--text, inherit))",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
      fontSize: "12px",
      lineHeight: "1.6",
      borderRadius: "8px",
      border: "1px solid var(--border, rgba(255,255,255,0.08))",
      overflow: "hidden",
    },
    "&.cm-focused": {
      outline: "none",
      borderColor: "var(--border2, rgba(255,255,255,0.18))",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    },
    ".cm-content": {
      padding: "10px 4px",
      caretColor: "var(--pre-text, #e2e8f0)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--code-bg, transparent)",
      color: "var(--muted, #7f8c98)",
      borderRight: "1px solid var(--border, rgba(255,255,255,0.08))",
      userSelect: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
      color: "var(--text, inherit)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.03)",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(124, 185, 255, 0.22) !important",
    },
    ".cm-panels": {
      backgroundColor: "var(--surface, #161b26)",
      color: "var(--text, #e2e8f0)",
      borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(250, 204, 21, 0.22)",
      outline: "1px solid rgba(250, 204, 21, 0.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(124, 185, 255, 0.35)",
    },
  });
}

function buildHighlightExt(mode: EditorMode): Extension {
  if (mode === "raw") return [];
  return syntaxHighlighting(initialThemeHighlightStyle, { fallback: true });
}

function buildEditableExt(isEditable: boolean): Extension[] {
  return [
    EditorState.readOnly.of(!isEditable),
    EditorView.editable.of(isEditable),
    EditorView.editorAttributes.of({
      class: isEditable ? "ck-cm-editing" : "ck-cm-readonly",
    }),
  ];
}

export function CodeFileEditor() {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const highlightCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const historyCompartment = useRef(new Compartment());

  const stateRef = useRef<{
    path: string;
    savedContent: string;
    mode: EditorMode;
    readOnly: boolean;
    onChange?: (content: string, dirty: boolean) => void;
    onSave?: (content: string) => void | Promise<void>;
  }>({
    path: "",
    savedContent: "",
    mode: "styled",
    readOnly: false,
  });

  useEffect(() => {
    const findHost = () => {
      const el = document.getElementById("cockpitCodeEditorHost");
      if (el) setHostEl(el);
      return Boolean(el);
    };
    if (!findHost()) {
      const observer = new MutationObserver(() => {
        if (findHost()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }
  }, []);

  useEffect(() => {
    if (!hostEl || !containerRef.current) return;

    const saveCommand = () => {
      const view = viewRef.current;
      if (!view || stateRef.current.readOnly || stateRef.current.mode !== "edit") return true;
      const content = view.state.doc.toString();
      void stateRef.current.onSave?.(content);
      return true;
    };

    const startState = EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        historyCompartment.current.of(history()),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        buildBaseTheme(),
        langCompartment.current.of([]),
        highlightCompartment.current.of([]),
        editableCompartment.current.of(buildEditableExt(false)),
        keymap.of([
          { key: "Mod-s", run: saveCommand, preventDefault: true },
          { key: "Mod-/", run: toggleComment, preventDefault: true },
          { key: "Shift-Alt-a", run: toggleBlockComment, preventDefault: true },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          const dirty = next !== stateRef.current.savedContent;
          stateRef.current.onChange?.(next, dirty);
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });
    viewRef.current = view;

    const skinObserver = new MutationObserver(() => {
      if (stateRef.current.mode !== "raw") {
        view.dispatch({
          effects: highlightCompartment.current.reconfigure(
            buildHighlightExt(stateRef.current.mode)
          ),
        });
      }
    });
    skinObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-skin", "class"],
    });

    window.cockpitEditor = {
      open(opts) {
        const mode: EditorMode =
          opts.mode === "raw" ? "raw" : opts.mode === "edit" ? "edit" : "styled";
        const forceReadOnly = Boolean(opts.readOnly);
        const canEdit = mode === "edit" && !forceReadOnly;
        stateRef.current = {
          path: opts.path || "",
          savedContent: opts.content ?? "",
          mode,
          readOnly: forceReadOnly,
          onChange: opts.onChange,
          onSave: opts.onSave,
        };
        const langExt = mode === "raw" ? [] : languageForPath(opts.path);
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: opts.content ?? "",
          },
          effects: [
            langCompartment.current.reconfigure(langExt),
            highlightCompartment.current.reconfigure(buildHighlightExt(mode)),
            editableCompartment.current.reconfigure(buildEditableExt(canEdit)),
            historyCompartment.current.reconfigure([]),
            historyCompartment.current.reconfigure(history()),
          ],
        });
        if (canEdit) view.focus();
      },
      setMode(mode) {
        const nextMode: EditorMode =
          mode === "raw" ? "raw" : mode === "edit" ? "edit" : "styled";
        stateRef.current.mode = nextMode;
        const canEdit = nextMode === "edit" && !stateRef.current.readOnly;
        const langExt = nextMode === "raw" ? [] : languageForPath(stateRef.current.path);
        view.dispatch({
          effects: [
            langCompartment.current.reconfigure(langExt),
            highlightCompartment.current.reconfigure(buildHighlightExt(nextMode)),
            editableCompartment.current.reconfigure(buildEditableExt(canEdit)),
          ],
        });
        if (canEdit) view.focus();
      },
      getContent() {
        return view.state.doc.toString();
      },
      setContent(content, markSaved = false) {
        if (markSaved) {
          stateRef.current.savedContent = content;
        }
        const current = view.state.doc.toString();
        if (current !== content) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content },
          });
        }
      },
      isEditable() {
        return stateRef.current.mode === "edit" && !stateRef.current.readOnly;
      },
      isDirty() {
        return view.state.doc.toString() !== stateRef.current.savedContent;
      },
      markClean(savedContent) {
        stateRef.current.savedContent =
          savedContent !== undefined ? savedContent : view.state.doc.toString();
      },
      focus() {
        view.focus();
      },
      close() {
        stateRef.current.path = "";
        stateRef.current.savedContent = "";
      },
    };

    return () => {
      skinObserver.disconnect();
      delete window.cockpitEditor;
      view.destroy();
      viewRef.current = null;
    };
  }, [hostEl]);

  if (!hostEl) return null;
  return createPortal(
    <div
      ref={containerRef}
      style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}
    />,
    hostEl
  );
}
