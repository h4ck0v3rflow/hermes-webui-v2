import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { RightPanelApp } from "./right-panel/RightPanelApp";
import { CodeFileEditor } from "./editor/CodeFileEditor";
import {
  usePanelBridgeStore,
  type ExtraPanelTab,
} from "./stores/panelBridgeStore";

interface LegacyWindow extends Window {
  __HERMES_GET_S__?: () => {
    session?: { session_id?: string; workspace?: string } | null;
  } | null;
  __HERMES_PENDING_BRIDGE_STATE__?: {
    sessionId?: string | null;
    workspace?: string;
    activeTab?: ExtraPanelTab | null;
  };
}

function installBridge() {
  const store = usePanelBridgeStore.getState();

  window.__HERMES_PANEL_BRIDGE__ = {
    setSession: (info) => usePanelBridgeStore.getState().setSession(info),
    openTab: (tab) => usePanelBridgeStore.getState().setActiveTab(tab),
  };

  const w = window as LegacyWindow;
  const pending = w.__HERMES_PENDING_BRIDGE_STATE__;
  if (pending) {
    if (pending.sessionId !== undefined) {
      store.setSession({
        sessionId: pending.sessionId ?? null,
        workspace: pending.workspace ?? "",
      });
    }
    if (pending.activeTab !== undefined) store.setActiveTab(pending.activeTab);
    delete w.__HERMES_PENDING_BRIDGE_STATE__;
  }

  const activeSession = w.__HERMES_GET_S__?.()?.session;
  if (activeSession?.session_id) {
    store.setSession({
      sessionId: activeSession.session_id,
      workspace: activeSession.workspace ?? "",
    });
  }
}

function mountExtraTabs() {
  installBridge();
  const mountEl = document.getElementById("cockpit-extra-tabs-root");
  if (!mountEl) return;
  createRoot(mountEl).render(
    <StrictMode>
      <RightPanelApp />
      <CodeFileEditor />
    </StrictMode>
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountExtraTabs, { once: true });
} else {
  mountExtraTabs();
}
