// Capture the current terminal state into a WorkspaceSnapshot. This is a PURE READ of the main store
// (no mutation). The result is JSON-cloned so later store mutations can't retroactively change a saved
// preset, and so anything non-serializable is dropped.
//
// INCLUDED: chart context (provider/symbol/timeframe/cluster-mode/grouping/display-mode), theme, pane
// visibility (+ bar stats), pane sizes, footprint settings, bar-statistics settings, drawing snap mode,
// and the chart objects (indicators/AVWAPs/drawings + indicator exec mode).
// NOT included: floating-window (FloatingWindow) drag geometry — those keep their own persistence.
//
// EXCLUDED (never captured): live candles/tick cache, scanner rows, alerts, connection/feed status,
// positions/orders/fills/PnL, replay runtime state, symbol configs, computed indicator outputs, all
// transient modal/dialog/selection/hover/anchor-pick UI flags, undo/redo history, and anything resembling
// an API key, credential, or backend env var (the store holds none of those).
import { useStore } from "../store/useStore";
import type { WorkspaceSnapshot } from "./types";

export function captureWorkspaceSnapshot(includeObjects = true): WorkspaceSnapshot {
  const s = useStore.getState();
  const snap: WorkspaceSnapshot = {
    context: {
      source: s.source,
      symbol: s.symbol,
      timeframe: s.timeframe,
      footprintMode: s.footprintMode,
      consolidation: s.consolidation,
      chartDisplayMode: s.chartDisplayMode,
    },
    theme: s.theme,
    panes: { ...s.panes, barStats: s.showBarStats },
    layout: { ...s.layout },
    settings: { ...s.settings },
    barStatsSettings: { ...s.barStatsSettings },
    snapMode: s.snapMode,
  };
  if (includeObjects) {
    snap.indicators = s.indicators;
    snap.indicatorExecutionMode = s.indicatorExecutionMode;
    snap.drawings = s.drawings;
  }
  // deep clone + strip anything non-serializable; also detaches from live store references
  return JSON.parse(JSON.stringify(snap)) as WorkspaceSnapshot;
}

// Apply a snapshot to the live terminal via the single store entry point.
export function applyWorkspaceSnapshot(snap: WorkspaceSnapshot, replaceObjects: boolean): void {
  useStore.getState().applyWorkspaceSnapshot(snap, { replaceObjects });
}
