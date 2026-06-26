// Built-in factory workspace presets. These are defined in code (never persisted) so they are always
// available — even with an empty/corrupt localStorage — and cannot be deleted or overwritten. They are
// LAYOUT-ONLY: each snapshot carries chart context + theme + pane visibility/sizes + footprint/bar-stats
// settings, but NO indicators/AVWAPs/drawings. So applying a factory preset never touches the user's
// chart objects (a normal Apply is non-destructive; there is nothing to "replace").
import { DEFAULT_BAR_STAT_SETTINGS } from "../barStats/types";
import { DEFAULT_LAYOUT, DEFAULT_PANES, DEFAULT_SETTINGS, type DashboardLayout } from "../store/useStore";
import { WORKSPACE_SCHEMA_VERSION, type WorkspaceContext, type WorkspacePanes, type WorkspacePresetV1, type WorkspaceSnapshot } from "./types";

function snapshot(over: {
  context?: Partial<WorkspaceContext>;
  theme?: "dark" | "light";
  panes?: Partial<WorkspacePanes>;
  layout?: Partial<DashboardLayout>;
}): WorkspaceSnapshot {
  return {
    context: { ...(over.context ?? {}) },
    theme: over.theme ?? "light",
    panes: { ...DEFAULT_PANES, barStats: false, ...(over.panes ?? {}) },
    layout: { ...DEFAULT_LAYOUT, ...(over.layout ?? {}) },
    settings: { ...DEFAULT_SETTINGS },
    barStatsSettings: { ...DEFAULT_BAR_STAT_SETTINGS },
    snapMode: "off",
    // intentionally no indicators / drawings — factory presets are layout-only
  };
}

// Stable ids (prefixed so they never collide with generated user-preset ids).
export const FACTORY_PRESETS: WorkspacePresetV1[] = [
  {
    version: WORKSPACE_SCHEMA_VERSION,
    id: "factory:gc-scalping",
    name: "GC Scalping",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    snapshot: snapshot({
      // GC-specific: switches provider/symbol/timeframe to the gold scalping context
      context: { source: "databento", symbol: "GC.V.0", timeframe: "2m", footprintMode: "bidAsk", consolidation: 1, chartDisplayMode: "footprint" },
      panes: { dom: true, hist: false, cum: true, scanner: true, barStats: true },
    }),
  },
  {
    version: WORKSPACE_SCHEMA_VERSION,
    id: "factory:clean-candles",
    name: "Clean Candles",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    snapshot: snapshot({
      // keep the current symbol/provider; just a clean candlestick chart with side panels hidden
      context: { chartDisplayMode: "candle" },
      panes: { dom: false, hist: false, cum: false, scanner: false, barStats: false },
    }),
  },
  {
    version: WORKSPACE_SCHEMA_VERSION,
    id: "factory:order-flow-research",
    name: "Order Flow Research",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    snapshot: snapshot({
      context: { chartDisplayMode: "footprint" },
      panes: { dom: false, hist: false, cum: true, scanner: true, barStats: true },
    }),
  },
  {
    version: WORKSPACE_SCHEMA_VERSION,
    id: "factory:execution-layout",
    name: "Execution Layout",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    snapshot: snapshot({
      // DOM ladder front-and-center, compact scanner, main chart + CVD; display mode = current default
      context: {},
      panes: { dom: true, hist: false, cum: true, scanner: true, barStats: false },
      layout: { domColumnWidth: 320, rightColumnWidth: 280 },
    }),
  },
];

export function isFactoryId(id: string): boolean {
  return id.startsWith("factory:");
}
