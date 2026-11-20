import { create } from "zustand";
import { apiFetch } from "../lib/apiFetch";

export type TerminalStatus = "idle" | "connecting" | "live" | "closed" | "error";

interface TerminalState {
  statusBySession: Record<string, TerminalStatus>;
  workspaceBySession: Record<string, string>;
  errorBySession: Record<string, string | null>;
  setStatus: (sessionId: string, status: TerminalStatus, error?: string | null) => void;
  startTerminal: (
    sessionId: string,
    cols: number,
    rows: number,
    restart?: boolean
  ) => Promise<boolean>;
  sendInput: (sessionId: string, data: string) => Promise<void>;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (sessionId: string) => Promise<void>;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  statusBySession: {},
  workspaceBySession: {},
  errorBySession: {},

  setStatus: (sessionId, status, error = null) =>
    set((s) => ({
      statusBySession: { ...s.statusBySession, [sessionId]: status },
      errorBySession: { ...s.errorBySession, [sessionId]: error },
    })),

  startTerminal: async (sessionId, cols, rows, restart = false) => {
    set((s) => ({
      statusBySession: { ...s.statusBySession, [sessionId]: "connecting" },
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    }));
    try {
      const res = await apiFetch<{
        ok?: boolean;
        workspace?: string;
        running?: boolean;
      }>("/api/terminal/start", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, cols, rows, restart }),
      });
      set((s) => ({
        statusBySession: {
          ...s.statusBySession,
          [sessionId]: res?.running === false ? "closed" : "live",
        },
        workspaceBySession: {
          ...s.workspaceBySession,
          [sessionId]: res?.workspace ?? s.workspaceBySession[sessionId] ?? "",
        },
      }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start terminal";
      set((s) => ({
        statusBySession: { ...s.statusBySession, [sessionId]: "error" },
        errorBySession: { ...s.errorBySession, [sessionId]: msg },
      }));
      return false;
    }
  },

  sendInput: async (sessionId, data) => {
    if (!sessionId || !data) return;
    await apiFetch("/api/terminal/input", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, data }),
    }).catch(() => {});
  },

  resizeTerminal: async (sessionId, cols, rows) => {
    if (!sessionId || cols <= 0 || rows <= 0) return;
    await apiFetch("/api/terminal/resize", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, cols, rows }),
    }).catch(() => {});
  },

  closeTerminal: async (sessionId) => {
    if (!sessionId) return;
    await apiFetch("/api/terminal/close", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => {});
    set((s) => ({
      statusBySession: { ...s.statusBySession, [sessionId]: "closed" },
    }));
  },
}));
