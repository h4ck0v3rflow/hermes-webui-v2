import { create } from "zustand";

export type ExtraPanelTab = "cmd" | "browser" | "findings" | "proxy";

export interface HermesPanelBridgeApi {
  setSession: (info: {
    sessionId: string | null;
    workspace?: string;
    program?: string;
  }) => void;
  openTab: (tab: ExtraPanelTab | null) => void;
}

declare global {
  interface Window {
    __HERMES_PANEL_BRIDGE__?: HermesPanelBridgeApi;
  }
}

interface PanelBridgeState {
  sessionId: string | null;
  workspace: string;
  program: string;
  activeTab: ExtraPanelTab | null;
  setSession: (info: {
    sessionId: string | null;
    workspace?: string;
    program?: string;
  }) => void;
  setActiveTab: (tab: ExtraPanelTab | null) => void;
}

export const usePanelBridgeStore = create<PanelBridgeState>((set) => ({
  sessionId: null,
  workspace: "",
  program: "default",
  activeTab: null,

  setSession: ({ sessionId, workspace = "", program }) =>
    set((state) => ({
      sessionId,
      workspace,
      program:
        program ??
        (workspace
          ? workspace.split(/[\\/]/).filter(Boolean).pop() || "default"
          : state.program),
    })),

  setActiveTab: (activeTab) => set({ activeTab }),
}));
