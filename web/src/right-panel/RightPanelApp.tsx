import { Component, lazy, Suspense, type ReactNode } from "react";
import { usePanelBridgeStore } from "../stores/panelBridgeStore";

class TabErrorBoundary extends Component<
  { tabKey: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: { tabKey: string }) {
    if (prevProps.tabKey !== this.props.tabKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-red-400">
          <p className="font-medium">Failed to load tab</p>
          <p className="text-[11px] text-[var(--oh-muted)]">
            {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const BrowserTab = lazy(() => import("./BrowserTab"));
const FindingsTab = lazy(() => import("./FindingsTab"));
const HttpProxyTab = lazy(() => import("./HttpProxyTab"));
const TerminalPane = lazy(() =>
  import("../components/workbench/TerminalPane").then((m) => ({
    default: m.TerminalPane,
  }))
);

/** One pane that stays MOUNTED when hidden — switching tabs must not destroy state
 * or reconnect streams (previously `key={activeTab}` unmounted the pane, so every
 * tab switch reloaded it: scrollback, captures and inspector selection all lost). */
function Pane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className="flex-1 flex-col min-w-0 min-h-0"
      style={{ display: active ? "flex" : "none" }}
      aria-hidden={active ? undefined : true}
    >
      {children}
    </div>
  );
}

export function RightPanelApp() {
  const sessionId = usePanelBridgeStore((s) => s.sessionId);
  const activeTab = usePanelBridgeStore((s) => s.activeTab);

  if (!activeTab) return null;

  if (!sessionId && activeTab !== "findings") {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-[var(--oh-muted)]">
        Start or select a Hermes session to attach CMD, Browser, and HTTP Proxy.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 h-full w-full bg-[var(--oh-canvas)] text-[var(--oh-text)]">
      <TabErrorBoundary tabKey={activeTab}>
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-xs text-[var(--oh-muted)]">
              Loading {activeTab}…
            </div>
          }
        >
          <Pane active={activeTab === "cmd"}>
            {sessionId ? (
              <TerminalPane sessionId={sessionId} active={activeTab === "cmd"} />
            ) : null}
          </Pane>
          <Pane active={activeTab === "browser"}>
            {sessionId ? (
              <BrowserTab sessionId={sessionId} active={activeTab === "browser"} />
            ) : null}
          </Pane>
          <Pane active={activeTab === "findings"}>
            <FindingsTab />
          </Pane>
          <Pane active={activeTab === "proxy"}>
            {sessionId ? (
              <HttpProxyTab sessionId={sessionId} active={activeTab === "proxy"} />
            ) : null}
          </Pane>
        </Suspense>
      </TabErrorBoundary>
    </div>
  );
}
