import { create } from "zustand";
import { api } from "../api/rest";
import { consolidatedRowSize } from "../lib/rowsize";
import type {
  AlertMsg,
  ConnStatus,
  Fill,
  FootprintCandle,
  FootprintMode,
  FootprintSettings,
  Order,
  Position,
  ReplayState,
  ScannerRow,
  ServerMessage,
  SymbolConfig,
} from "../types/orderflow";
import { DEFAULT_BAR_STAT_SETTINGS, type BarStatMetricId, type BarStatSettings } from "../barStats/types";
import type {
  IndicatorExecutionMode,
  IndicatorInstance,
  IndicatorOutput,
  IndicatorVisibility,
} from "../indicators/types";
import { runIndicators, disposeSandbox } from "../indicators/engine";
import { loadIndicatorDataContext } from "../indicators/dataContext";
import { parseIndicatorMeta } from "../indicators/runtime";
import { DELTA_SPIKE_SCRIPT, ANCHORED_VWAP_SCRIPT } from "../indicators/examples";
import { SC1_1604_SCRIPT } from "../indicators/sc1_1604";
import type { DrawingObject, DrawingTool, SnapMode } from "../drawings/types";
import { CHART_CANDLE_LIMIT, snapshotRequestForMode } from "../lib/limits";

// Geometry of a floating workspace window (persisted per window id).
export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Persisted, user-resizable dashboard panel sizes (px).
export interface DashboardLayout {
  rightColumnWidth: number; // scanner / alerts column
  domColumnWidth: number; // DOM ladder column
  cumDeltaHeight: number; // Cumulative Delta panel
  histHeight: number; // Delta Histogram panel
  barStatsHeight: number; // Bar Statistics panel
}
export const DEFAULT_LAYOUT: DashboardLayout = {
  rightColumnWidth: 320,
  domColumnWidth: 280,
  cumDeltaHeight: 200,
  histHeight: 180,
  barStatsHeight: 150,
};
export const LAYOUT_BOUNDS: Record<keyof DashboardLayout, [number, number]> = {
  rightColumnWidth: [280, 640],
  domColumnWidth: [240, 500],
  cumDeltaHeight: [120, 420],
  histHeight: [120, 380],
  barStatsHeight: [90, 360],
};
function clampLayoutValue(key: keyof DashboardLayout, v: number): number {
  const [min, max] = LAYOUT_BOUNDS[key];
  return Math.max(min, Math.min(max, Math.round(v)));
}

export const DEFAULT_SETTINGS: FootprintSettings = {
  tickMultiplier: 1,
  imbalanceRatio: 3.0,
  imbalanceMinVolume: 50,
  // VWAP line + SD bands (the orange line/bands) and signal badges are OFF by default
  // for a clean chart; re-enable any of these in Footprint Settings. Execution fills stay on.
  showVwap: false,
  showSdBands: false,
  showPoc: true,
  showImbalances: true,
  showBadges: false,
  showFills: true,
  showThinCandle: true,
  lockBlockSize: false,
  // institutional footprint settings — defaults reproduce the current clean look
  // (single column, bid×ask via the toolbar selector, delta-hued volume-intensity fills).
  showLastValue: true,
  showSeriesName: false,
  showCluster: true,
  clusterColumns: "single",
  colorMatrix: "default",
  autoFontSize: true,
  fixedFontSize: 10,
  textDensity: "auto",
  showProfile: false,
  leftFormat: "sellVolume",
  rightFormat: "buyVolume",
  leftTextColor: "",
  rightTextColor: "",
  leftBackground: false,
  rightBackground: false,
  leftFill: "",
  rightFill: "",
  imbalanceBuyColor: "",
  imbalanceSellColor: "",
  pocColor: "",
  showPocMarker: false,
  pocMarkerColor: "",
  extendPoc: false,
};

// chart history budget (default 15k; indicators run on a smaller window - see limits.ts)
const MAX_CANDLES = CHART_CANDLE_LIMIT;
const MAX_ALERTS = 100;
const MAX_FILLS = 500;

// ---------------------------------------------------------------- indicators
const INDICATORS_LS_KEY = "vikings.indicators.v1";

function uid(): string {
  return `ind_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function makeIndicator(script: string, enabled: boolean): IndicatorInstance {
  const meta = parseIndicatorMeta(script);
  const ts = Date.now();
  return {
    id: uid(),
    name: meta.name,
    script,
    enabled,
    inputs: meta.inputs,
    overlay: meta.overlay,
    createdAt: ts,
    updatedAt: ts,
    lastError: meta.error ?? null,
    kind: meta.kind,
  };
}

// Distinguishable display name for a new Anchored VWAP: "Anchored VWAP",
// "Anchored VWAP 2", ... (instance.name only; the script's indicator() name is unchanged).
function anchoredVwapName(existing: IndicatorInstance[]): string {
  const n = existing.filter((i) => i.kind === "anchored-vwap").length;
  return n === 0 ? "Anchored VWAP" : `Anchored VWAP ${n + 1}`;
}

interface PersistedIndicators {
  indicators: IndicatorInstance[];
  mode: IndicatorExecutionMode;
}

// Migrate a Phase-1 Anchored VWAP instance (anchorMode/anchorIndex, no anchorTime) to the
// Phase-2 click-to-anchor script. Preserves id/enabled/createdAt + compatible inputs
// (source/showBands/bandStd1/bandStd2); resets the anchor so the user must EXPLICITLY pick
// a candle (no silent first-candle anchor). Non-AVWAP instances pass through unchanged.
function migrateAnchoredVwap(i: IndicatorInstance): IndicatorInstance {
  const script = typeof i.script === "string" ? i.script : "";
  const isOldAvwap =
    /anchorMode/.test(script) && !/anchorTime/.test(script) && /["']Anchored VWAP["']/.test(script);
  if (!isOldAvwap) return i;
  const oldIn: Record<string, number | string | boolean> = i.inputs || {};
  const inputs: Record<string, number | string | boolean> = { anchorTime: 0, anchorSymbol: "" };
  for (const k of ["source", "showBands", "bandStd1", "bandStd2"]) {
    const v = oldIn[k];
    if (v !== undefined) inputs[k] = v;
  }
  return {
    ...i,
    name: "Anchored VWAP",
    script: ANCHORED_VWAP_SCRIPT,
    overlay: true,
    inputs,
    kind: "anchored-vwap",
    updatedAt: Date.now(),
    lastError: null,
  };
}

function migrateSc1Indicator(i: IndicatorInstance): IndicatorInstance {
  const script = typeof i.script === "string" ? i.script : "";
  const isSc1 = i.name === "SC1 1604 Replica" || /["']SC1 1604 Replica["']/.test(script);
  if (!isSc1 || script === SC1_1604_SCRIPT) return i;
  return {
    ...i,
    name: "SC1 1604 Replica",
    script: SC1_1604_SCRIPT,
    overlay: true,
    inputs: {
      ...(i.inputs || {}),
      showI1Markers: true,
      showI2Markers: false,
      showI3Markers: false,
      showSuperSignals: false,
      showDebugStrength: false,
    },
    updatedAt: Date.now(),
    lastError: null,
  };
}
function loadPersistedIndicators(): PersistedIndicators {
  try {
    const raw = localStorage.getItem(INDICATORS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedIndicators>;
      let migrated = false;
      const indicators = (Array.isArray(p.indicators)
        ? p.indicators.filter((i) => i && typeof i.id === "string" && typeof i.script === "string")
        : []
      )
        .map((i) => {
          let m = migrateAnchoredVwap(i);
          m = migrateSc1Indicator(m);
          if (m !== i) migrated = true;
          return m;
        })
        .map((i) =>
          // Clear a STALE "Indicator timed out" error persisted before the perf fix so the
          // panel doesn't keep showing a timeout that no longer happens. The indicator stays
          // in its saved enabled/disabled state; the user just sees it clean (and re-enabling
          // recomputes it fresh). Non-timeout errors are preserved.
          i.lastError && /timed out/i.test(i.lastError) ? { ...i, lastError: null } : i,
        );
      const mode: IndicatorExecutionMode =
        p.mode === "direct" || p.mode === "disabled" || p.mode === "sandbox" ? p.mode : "sandbox";
      // make the migration durable so old Phase-1 scripts don't linger in storage
      if (migrated) persistIndicators(indicators, mode);
      return { indicators, mode };
    }
  } catch {
    /* fall through to defaults on any parse/storage error */
  }
  // default: one DISABLED example so users can inspect it without noisy overlays
  return { indicators: [makeIndicator(DELTA_SPIKE_SCRIPT, false)], mode: "sandbox" };
}

function persistIndicators(indicators: IndicatorInstance[], mode: IndicatorExecutionMode): void {
  try {
    localStorage.setItem(INDICATORS_LS_KEY, JSON.stringify({ indicators, mode }));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// ----------------------------------------------- chart drawings + floating windows
// Same manual-persistence pattern as indicators (no zustand middleware): a load helper
// called once into a module const before create(), and a persist helper called inside
// every mutating action. Drawings are stored in DATA coords + per-symbol so they
// survive pan/zoom/symbol/timeframe switches.
const DRAWINGS_LS_KEY = "vikings.drawings.v1";
const WINDOWS_LS_KEY = "vikings.windows.v1";

function loadPersistedDrawings(): DrawingObject[] {
  try {
    const raw = localStorage.getItem(DRAWINGS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { drawings?: unknown };
      if (Array.isArray(p.drawings)) {
        return p.drawings.filter(
          (d): d is DrawingObject =>
            !!d &&
            typeof (d as DrawingObject).id === "string" &&
            typeof (d as DrawingObject).type === "string" &&
            typeof (d as DrawingObject).symbol === "string" &&
            Array.isArray((d as DrawingObject).points),
        );
      }
    }
  } catch {
    /* fall through to empty on any parse/storage error */
  }
  return [];
}

function persistDrawings(drawings: DrawingObject[]): void {
  try {
    localStorage.setItem(DRAWINGS_LS_KEY, JSON.stringify({ drawings }));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// Undo/redo history holds snapshots of the `drawings` array ONLY (small immutable
// objects produced by each action via map/filter/spread, so the reference is safe to
// retain - no deep copy needed, and never any candle data). Bounded so a long editing
// session can't grow memory without limit.
const UNDO_LIMIT = 100;
function pushHistory(stack: DrawingObject[][], snapshot: DrawingObject[]): DrawingObject[][] {
  const next = stack.length >= UNDO_LIMIT ? stack.slice(stack.length - UNDO_LIMIT + 1) : stack.slice();
  next.push(snapshot);
  return next;
}

function loadPersistedWindows(): Record<string, WindowRect> {
  try {
    const raw = localStorage.getItem(WINDOWS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, WindowRect> = {};
      for (const [k, v] of Object.entries(p)) {
        const r = v as Partial<WindowRect>;
        if (
          r &&
          typeof r.x === "number" &&
          typeof r.y === "number" &&
          typeof r.w === "number" &&
          typeof r.h === "number"
        ) {
          out[k] = { x: r.x, y: r.y, w: r.w, h: r.h };
        }
      }
      return out;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

function persistWindows(windows: Record<string, WindowRect>): void {
  try {
    localStorage.setItem(WINDOWS_LS_KEY, JSON.stringify(windows));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

const LAYOUT_LS_KEY = "vikings.layout.v1";
function loadPersistedLayout(): DashboardLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DashboardLayout>;
      const out = { ...DEFAULT_LAYOUT };
      (Object.keys(DEFAULT_LAYOUT) as (keyof DashboardLayout)[]).forEach((k) => {
        const v = p[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = clampLayoutValue(k, v);
      });
      return out;
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_LAYOUT };
}
function persistLayout(layout: DashboardLayout): void {
  try {
    localStorage.setItem(LAYOUT_LS_KEY, JSON.stringify(layout));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// ----------------------------------------------- footprint settings (persisted)
// Same manual pattern: a saved partial is merged OVER DEFAULT_SETTINGS with defensive
// per-key validation (numbers must be finite, booleans must be booleans, unknown keys
// ignored), so user toggles (VWAP / SD bands / badges / fills...) survive a reload.
const SETTINGS_LS_KEY = "vikings.settings.v1";
const SETTINGS_NUMERIC_KEYS: ReadonlyArray<keyof FootprintSettings> = [
  "tickMultiplier",
  "imbalanceRatio",
  "imbalanceMinVolume",
  "fixedFontSize",
];
// string-valued settings (enums + color hexes); validated as strings, unknown keys ignored
const SETTINGS_STRING_KEYS: ReadonlyArray<keyof FootprintSettings> = [
  "clusterColumns",
  "colorMatrix",
  "textDensity",
  "leftFormat",
  "rightFormat",
  "leftTextColor",
  "rightTextColor",
  "leftFill",
  "rightFill",
  "imbalanceBuyColor",
  "imbalanceSellColor",
  "pocColor",
  "pocMarkerColor",
];
function loadPersistedSettings(): FootprintSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const out = { ...DEFAULT_SETTINGS };
      const sink = out as Record<string, number | boolean | string>;
      (Object.keys(DEFAULT_SETTINGS) as (keyof FootprintSettings)[]).forEach((k) => {
        const v = p[k];
        if (SETTINGS_NUMERIC_KEYS.includes(k)) {
          if (typeof v === "number" && Number.isFinite(v)) sink[k] = v;
        } else if (SETTINGS_STRING_KEYS.includes(k)) {
          if (typeof v === "string") sink[k] = v;
        } else if (typeof v === "boolean") {
          sink[k] = v;
        }
      });
      return out;
    }
  } catch {
    /* fall through to clean defaults on any parse/storage error */
  }
  return { ...DEFAULT_SETTINGS };
}
function persistSettings(settings: FootprintSettings): void {
  try {
    localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// ---- Bar Statistics persistence (separate key; visibility + settings) ----
const BARSTATS_LS_KEY = "vikings.barstats.v1";
function loadPersistedBarStats(): { show: boolean; settings: BarStatSettings } {
  const fallback = { show: false, settings: { ...DEFAULT_BAR_STAT_SETTINGS } };
  try {
    const raw = localStorage.getItem(BARSTATS_LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<{ show: boolean; settings: Partial<BarStatSettings> }>;
    const merged = { ...DEFAULT_BAR_STAT_SETTINGS, ...(p.settings ?? {}) };
    // the pane filters enabled ids to AVAILABLE metrics at render time, so a stale id is harmless
    if (!Array.isArray(merged.enabled)) merged.enabled = [...DEFAULT_BAR_STAT_SETTINGS.enabled];
    return { show: typeof p.show === "boolean" ? p.show : false, settings: merged };
  } catch {
    return fallback;
  }
}
function persistBarStats(show: boolean, settings: BarStatSettings): void {
  try {
    localStorage.setItem(BARSTATS_LS_KEY, JSON.stringify({ show, settings }));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// debounced + race-guarded recompute (declared before the store; called at runtime
// after `useStore` exists, so the forward reference is safe)
let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
let recomputeSeq = 0;
function scheduleRecompute(delay = 150): void {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    void useStore.getState().recomputeIndicators();
  }, delay);
}
// Invalidate any in-flight recompute so its (now stale-context) async result is dropped.
// Called by every context switch (symbol / timeframe / consolidation / source / replay
// exit) that clears candles, so a slow run for the old context can't overwrite outputs
// for the new one. recomputeIndicators also re-checks the context after its await.
function bumpRecomputeSeq(): void {
  recomputeSeq++;
}

interface State {
  source: "truedata" | "databento";
  symbol: string;
  timeframe: string;
  connected: boolean;
  status: ConnStatus | null;
  candles: FootprintCandle[];
  scanner: ScannerRow[];
  alerts: AlertMsg[];
  replay: ReplayState | null;
  replayActive: boolean;
  footprintMode: FootprintMode;
  consolidation: number;   // price-grouping multiplier (1x default)
  chartDisplayMode: "footprint" | "candle";
  theme: "dark" | "light";
  settings: FootprintSettings;
  // Bar Statistics pane (candle-aligned per-bar metric grid)
  showBarStats: boolean;
  barStatsSettings: BarStatSettings;
  barStatsSettingsOpen: boolean;
  // ephemeral (NOT persisted): which metrics have usable data on the currently-loaded payload, so
  // the settings modal can flag enabled-but-unavailable metrics. Published by the pane.
  barStatAvailability: Partial<Record<BarStatMetricId, boolean>>;
  blockSizeModalOpen: boolean;
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  symbolConfigs: Record<string, SymbolConfig>;

  // custom indicators
  indicators: IndicatorInstance[];
  indicatorOutputs: IndicatorOutput[];
  indicatorExecutionMode: IndicatorExecutionMode;
  indicatorBusy: boolean;
  indicatorErrors: Record<string, string | null>;
  // id of the existing indicator waiting for a chart-click re-anchor (null = not picking)
  pendingAnchorIndicatorId: string | null;
  // toolbar placement mode: drop a NEW Anchored VWAP on the next candle click (null = off)
  pendingAnchorTool: "anchored-vwap" | null;
  // indicator-management UI (TradingView-style): the ƒx panel + the per-indicator
  // Settings / Source-code dialogs (each holds the target instance id, null = closed).
  indicatorsPanelOpen: boolean;
  footprintSettingsOpen: boolean; // footprint Settings modal (gear + chart right-click)
  settingsIndicatorId: string | null;
  sourceIndicatorId: string | null;

  // chart drawings (objects) + floating workspace windows
  drawings: DrawingObject[];
  activeTool: DrawingTool; // "select" = idle cursor; otherwise a placement tool is armed
  selectedDrawingId: string | null;
  // an Anchored VWAP (indicator) selected on the chart (mutually exclusive with a
  // selected drawing). null = no indicator selected. Drives the AVWAP selection toolbar.
  selectedIndicatorId: string | null;
  // magnet/snap mode for drawing-point placement (price snaps to candle features)
  snapMode: SnapMode;
  // undo/redo history of the `drawings` array only (bounded; never holds candle data)
  undoStack: DrawingObject[][];
  redoStack: DrawingObject[][];
  windows: Record<string, WindowRect>;

  // resizable dashboard panel sizes (persisted)
  layout: DashboardLayout;

  setSource: (src: "truedata" | "databento") => void;
  setSymbol: (s: string) => void;
  setTimeframe: (tf: string) => void;
  setConnected: (c: boolean) => void;
  setScanner: (rows: ScannerRow[]) => void;
  setFootprintMode: (m: FootprintMode) => void;
  setConsolidation: (n: number) => void;
  setChartDisplayMode: (m: "footprint" | "candle") => void;
  toggleTheme: () => void;
  setSettings: (patch: Partial<FootprintSettings>) => void;
  resetSettings: () => void;
  setShowBarStats: (v: boolean) => void;
  setBarStatsSettings: (patch: Partial<BarStatSettings>) => void;
  resetBarStatsSettings: () => void;
  setBarStatsSettingsOpen: (open: boolean) => void;
  setBarStatAvailability: (map: Partial<Record<BarStatMetricId, boolean>>) => void;
  setBlockSizeModalOpen: (open: boolean) => void;
  ingest: (msg: ServerMessage) => void;
  loadSnapshot: (symbol: string, timeframe: string, candles: FootprintCandle[]) => void;
  loadLiveSnapshot: () => void;
  // switch (symbol, timeframe) together for a scanner-row click (no-op if unchanged)
  selectChartContext: (symbol: string, timeframe: string) => void;
  loadSymbolConfigs: () => Promise<void>;
  // indicator actions
  addIndicator: (script: string) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorInstance>) => void;
  removeIndicator: (id: string) => void;
  toggleIndicator: (id: string) => void;
  setIndicatorExecutionMode: (mode: IndicatorExecutionMode) => void;
  recomputeIndicators: () => Promise<void>;
  // interactive anchor picking (TradingView-style Anchored VWAP)
  beginIndicatorAnchorPick: (indicatorId: string) => void;
  cancelIndicatorAnchorPick: () => void;
  setIndicatorAnchor: (indicatorId: string, anchorTime: number, anchorSymbol?: string) => void;
  beginAnchoredVwapPlacement: () => void;
  addAnchoredVwapAt: (anchorTime: number, anchorSymbol?: string) => void;
  removeAllAnchoredVwaps: () => void;
  // indicator-management UI actions (legend / context menu / dialogs)
  setIndicatorsPanelOpen: (open: boolean) => void;
  setFootprintSettingsOpen: (open: boolean) => void;
  setSettingsIndicatorId: (id: string | null) => void;
  setSourceIndicatorId: (id: string | null) => void;
  moveIndicator: (id: string, dir: -1 | 1) => void;
  duplicateIndicator: (id: string) => void;
  renameIndicator: (id: string, name: string) => void;
  setIndicatorVisibility: (id: string, visibility: IndicatorVisibility) => void;
  resetIndicatorInputs: (id: string) => void;
  // drawing-object actions
  setActiveTool: (tool: DrawingTool) => void;
  addDrawing: (d: DrawingObject) => void;
  updateDrawing: (id: string, patch: Partial<DrawingObject>) => void;
  removeDrawing: (id: string) => void;
  selectDrawing: (id: string | null) => void;
  selectIndicator: (id: string | null) => void;
  toggleDrawingVisible: (id: string) => void;
  toggleDrawingLock: (id: string) => void;
  clearDrawings: (symbol?: string) => void;
  setSnapMode: (mode: SnapMode) => void;
  undo: () => void;
  redo: () => void;
  // floating-window geometry persistence
  setWindowRect: (id: string, rect: WindowRect) => void;
  // dashboard layout (resizable panels)
  setLayout: (patch: Partial<DashboardLayout>) => void;
  resetLayout: (key: keyof DashboardLayout) => void;
  resetAllLayout: () => void;
  reset: () => void;
}

function upsert(candles: FootprintCandle[], c: FootprintCandle): FootprintCandle[] {
  const next = candles.slice();
  const i = next.findIndex((x) => x.startTime === c.startTime);
  if (i >= 0) next[i] = c;
  else next.push(c);
  next.sort((a, b) => a.startTime - b.startTime);
  return next.length > MAX_CANDLES ? next.slice(next.length - MAX_CANDLES) : next;
}

const persistedIndicators = loadPersistedIndicators();
const persistedDrawings = loadPersistedDrawings();
const persistedBarStats = loadPersistedBarStats();
const persistedWindows = loadPersistedWindows();
const persistedLayout = loadPersistedLayout();
const persistedSettings = loadPersistedSettings();

export const useStore = create<State>((set, get) => ({
  // dashboard defaults (no persistence for these yet -> these are the fresh-open values)
  source: "databento",
  symbol: "GC.V.0",
  timeframe: "2m",
  connected: false,
  status: null,
  candles: [],
  scanner: [],
  alerts: [],
  replay: null,
  replayActive: false,
  footprintMode: "bidAsk",
  consolidation: 1,
  chartDisplayMode: "candle",
  theme: "light",
  settings: persistedSettings,
  blockSizeModalOpen: false,
  positions: [],
  orders: [],
  fills: [],
  symbolConfigs: {},

  indicators: persistedIndicators.indicators,
  indicatorOutputs: [],
  indicatorExecutionMode: persistedIndicators.mode,
  indicatorBusy: false,
  indicatorErrors: {},
  pendingAnchorIndicatorId: null,
  pendingAnchorTool: null,
  indicatorsPanelOpen: false,
  footprintSettingsOpen: false,
  showBarStats: persistedBarStats.show,
  barStatsSettings: persistedBarStats.settings,
  barStatsSettingsOpen: false,
  barStatAvailability: {},
  settingsIndicatorId: null,
  sourceIndicatorId: null,

  drawings: persistedDrawings,
  activeTool: "select",
  selectedDrawingId: null,
  selectedIndicatorId: null,
  snapMode: "off",
  undoStack: [],
  redoStack: [],
  windows: persistedWindows,
  layout: persistedLayout,

  setSource: (src) => {
    // Use the CANONICAL upper-case symbol: the backend emits live candles as
    // "6E.V.0", and the store's candle filter is case-sensitive - a lowercase
    // default would render the static REST snapshot but drop every live update.
    const nextSymbol = src === "truedata" ? "NIFTY-I" : "6E.V.0";
    // clear indicatorOutputs (+ invalidate any in-flight run) so stale overlays never
    // render against new candles
    bumpRecomputeSeq();
    set({ source: src, symbol: nextSymbol, candles: [], indicatorOutputs: [] });
    get().loadLiveSnapshot();
  },
  // symbol/timeframe changes preserve the consolidation factor (only clear candles)
  setSymbol: (s) => {
    bumpRecomputeSeq();
    set({ symbol: s, candles: [], indicatorOutputs: [] });
  },
  setTimeframe: (tf) => {
    bumpRecomputeSeq();
    set({ timeframe: tf, candles: [], indicatorOutputs: [] });
  },
  setConnected: (c) => set({ connected: c }),
  setScanner: (rows) => set({ scanner: rows }),
  setFootprintMode: (m) => set({ footprintMode: m }),
  setConsolidation: (n) => {
    bumpRecomputeSeq();
    set({ consolidation: n, candles: [], indicatorOutputs: [] });
  },
  setChartDisplayMode: (m) => {
    if (get().chartDisplayMode === m) return;
    set({ chartDisplayMode: m });
    // refetch with the right payload for the new mode: candle = deep cells-free,
    // footprint = full cells on a smaller window. (Live WS candles always carry cells.)
    get().loadLiveSnapshot();
  },
  toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persistSettings(settings);
  },
  resetSettings: () => {
    const settings = { ...DEFAULT_SETTINGS };
    set({ settings });
    persistSettings(settings);
  },
  setShowBarStats: (v) => {
    set({ showBarStats: v });
    persistBarStats(v, get().barStatsSettings);
  },
  setBarStatsSettings: (patch) => {
    const next = { ...get().barStatsSettings, ...patch };
    set({ barStatsSettings: next });
    persistBarStats(get().showBarStats, next);
  },
  resetBarStatsSettings: () => {
    const next = { ...DEFAULT_BAR_STAT_SETTINGS };
    set({ barStatsSettings: next });
    persistBarStats(get().showBarStats, next);
  },
  setBarStatsSettingsOpen: (open) => set({ barStatsSettingsOpen: open }),
  setBarStatAvailability: (map) => set({ barStatAvailability: map }),
  setBlockSizeModalOpen: (open) => set({ blockSizeModalOpen: open }),

  // resizable dashboard layout: clamp each provided dimension + persist
  setLayout: (patch) => {
    const next = { ...get().layout };
    (Object.keys(patch) as (keyof DashboardLayout)[]).forEach((k) => {
      const v = patch[k];
      if (typeof v === "number" && Number.isFinite(v)) next[k] = clampLayoutValue(k, v);
    });
    set({ layout: next });
    persistLayout(next);
  },
  resetLayout: (key) => {
    const next = { ...get().layout, [key]: DEFAULT_LAYOUT[key] };
    set({ layout: next });
    persistLayout(next);
  },
  resetAllLayout: () => {
    const next = { ...DEFAULT_LAYOUT };
    set({ layout: next });
    persistLayout(next);
  },

  loadSnapshot: (symbol, timeframe, candles) => {
    const s = get();
    // ignore a stale LIVE snapshot (e.g. from a resubscribe) that lands after a
    // replay has (re)started, or after the user moved to a different symbol/tf
    if (s.replayActive || symbol !== s.symbol || timeframe !== s.timeframe) return;
    
    // and drop candles from a different consolidation level (mirrors the live guard).
    // If it's a live snapshot, ensure the candles match the active consolidation level.
    // If they don't, ignore the snapshot entirely to prevent wiping/corrupting the chart.
    const isReplay = candles.length > 0 && candles[0].replay;
    if (!isReplay && candles.length > 0) {
      const rs = consolidatedRowSize(s.symbol, s.consolidation);
      if (candles[0].rowSize !== rs) {
        return; // Ignore default base-row snapshot when viewing a consolidated level
      }
    }
    set({ candles: candles.slice(-MAX_CANDLES) });
    scheduleRecompute();
  },

  // pull the current live footprint snapshot for the active symbol/timeframe,
  // consolidated to the active price-grouping level
  loadLiveSnapshot: () => {
    const { symbol, timeframe, consolidation, chartDisplayMode } = get();
    const rowSize = consolidatedRowSize(symbol, consolidation);
    // candle mode -> deep cells-free payload (fast); footprint mode -> full cells, smaller window
    const { limit, cells } = snapshotRequestForMode(chartDisplayMode);
    api
      .footprints(symbol, timeframe, rowSize, limit, cells)
      .then((r) => {
        // ignore if the user moved on, a replay restarted, consolidation OR chart mode
        // changed meanwhile (a stale candle-mode payload must not overwrite footprint cells)
        const s = get();
        const rs = consolidatedRowSize(s.symbol, s.consolidation);
        if (
          s.replayActive ||
          s.symbol !== symbol ||
          s.timeframe !== timeframe ||
          rowSize !== rs ||
          s.chartDisplayMode !== chartDisplayMode
        )
          return;
        set({ candles: r.candles.slice(-MAX_CANDLES) });
        scheduleRecompute();
      })
      .catch(() => {});
  },

  // Switch the chart's (symbol, timeframe) together - used by Scanner row clicks.
  // No-op when nothing actually changes, so clicking the already-active row never
  // blanks the chart (the old setSymbol cleared candles even when the symbol was
  // unchanged, and the Header [symbol,timeframe] subscribe effect wouldn't re-fire to
  // refill them). When the context DOES change, clear stale candles/overlays, pull a
  // fresh REST snapshot immediately, and let the Header effect re-subscribe the WS.
  selectChartContext: (symbol, timeframe) => {
    const cur = get();
    if (cur.symbol === symbol && cur.timeframe === timeframe) return;
    bumpRecomputeSeq();
    set({ symbol, timeframe, candles: [], indicatorOutputs: [] });
    get().loadLiveSnapshot();
  },

  // fetch the per-symbol order-flow tuning table once (keys are UPPER-cased to
  // match how the renderer looks them up by symbol).
  loadSymbolConfigs: async () => {
    try {
      const data = await api.symbolConfig();
      const norm: Record<string, SymbolConfig> = {};
      for (const [k, v] of Object.entries(data)) norm[k.toUpperCase()] = v;
      set({ symbolConfigs: norm });
    } catch {
      /* keep defaults if the endpoint is unavailable */
    }
  },

  ingest: (msg) => {
    const st = get();
    switch (msg.type) {
      case "candle": {
        const c = msg.data;
        if (c.symbol !== st.symbol || c.timeframe !== st.timeframe) return;
        // ignore a LIVE candle from a different consolidation level (e.g. a stray
        // frame mid-switch) so price groupings never mix. Replay candles run at the
        // base row size and are exempt (the chart is showing the replay feed).
        if (!c.replay && c.rowSize !== consolidatedRowSize(st.symbol, st.consolidation)) return;
        set({ candles: upsert(st.candles, c) });
        scheduleRecompute();
        break;
      }
      case "snapshot": {
        st.loadSnapshot(msg.data.symbol, msg.data.timeframe, msg.data.candles);
        break;
      }
      case "status":
        set({ status: msg.data });
        break;
      case "alert":
        set({ alerts: [msg.data, ...st.alerts].slice(0, MAX_ALERTS) });
        break;
      case "position":
        set({ positions: msg.data });
        break;
      case "orders":
        set({ orders: msg.data });
        break;
      case "fill":
        set({ fills: [...st.fills, msg.data].slice(-MAX_FILLS) });
        break;
      case "replay":
        if (msg.data.exit) {
          // replay ended -> drop replay state, clear the chart (incl. replay-derived
          // indicator overlays + any in-flight run), resync to live
          bumpRecomputeSeq();
          set({ replay: null, replayActive: false, candles: [], indicatorOutputs: [] });
          get().loadLiveSnapshot();
        } else {
          set({ replay: msg.data, replayActive: true });
        }
        break;
    }
  },

  // ------------------------------------------------------------- indicators
  addIndicator: (script) => {
    const cur = get();
    const ind = makeIndicator(script, true);
    // give multiple Anchored VWAPs distinguishable names ("Anchored VWAP 2", ...)
    if (ind.kind === "anchored-vwap") ind.name = anchoredVwapName(cur.indicators);
    const indicators = [...cur.indicators, ind];
    set({ indicators });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  updateIndicator: (id, patch) => {
    const indicators = get().indicators.map((ind) => {
      if (ind.id !== id) return ind;
      let next: IndicatorInstance = { ...ind, ...patch, id: ind.id, updatedAt: Date.now() };
      if (typeof patch.script === "string" && patch.script !== ind.script) {
        const meta = parseIndicatorMeta(patch.script);
        next = {
          ...next,
          name: meta.name,
          overlay: meta.overlay,
          kind: meta.kind,
          // keep any user-set values for inputs the (new) script still declares
          inputs: { ...meta.inputs, ...(patch.inputs ?? ind.inputs) },
          lastError: meta.error ?? null,
        };
      }
      return next;
    });
    set({ indicators });
    persistIndicators(indicators, get().indicatorExecutionMode);
    scheduleRecompute(50);
  },

  removeIndicator: (id) => {
    const cur = get();
    const indicators = cur.indicators.filter((i) => i.id !== id);
    const errs = { ...cur.indicatorErrors };
    delete errs[id];
    // removing the instance drops its anchor (stored in inputs); also cancel an
    // in-progress anchor pick if it targeted this indicator.
    set({
      indicators,
      indicatorErrors: errs,
      pendingAnchorIndicatorId: cur.pendingAnchorIndicatorId === id ? null : cur.pendingAnchorIndicatorId,
      selectedIndicatorId: cur.selectedIndicatorId === id ? null : cur.selectedIndicatorId,
    });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  toggleIndicator: (id) => {
    const cur = get();
    const target = cur.indicators.find((i) => i.id === id);
    const enabling = target ? !target.enabled : false;
    const indicators = cur.indicators.map((i) =>
      i.id === id
        ? // re-enabling clears any stale error (e.g. a prior "Indicator timed out -
          // disabled") so a recovered indicator starts clean
          { ...i, enabled: !i.enabled, updatedAt: Date.now(), ...(enabling ? { lastError: null } : {}) }
        : i,
    );
    const errs = { ...cur.indicatorErrors };
    if (enabling) delete errs[id];
    set({ indicators, indicatorErrors: errs });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  setIndicatorExecutionMode: (mode) => {
    const prev = get().indicatorExecutionMode;
    if (prev === mode) return;
    // invalidate any in-flight run (a late result must not write outputs/errors for the
    // old mode) and clear stale overlays immediately - same discipline as a symbol switch
    bumpRecomputeSeq();
    if (prev === "sandbox") disposeSandbox();
    persistIndicators(get().indicators, mode);
    if (mode === "disabled") {
      set({ indicatorExecutionMode: mode, indicatorOutputs: [], indicatorErrors: {}, indicatorBusy: false });
    } else {
      set({ indicatorExecutionMode: mode, indicatorOutputs: [] });
      scheduleRecompute(50);
    }
  },

  recomputeIndicators: async () => {
    const s = get();
    const seq = ++recomputeSeq;
    const mode = s.indicatorExecutionMode;
    const enabled = s.indicators.filter((i) => i.enabled);
    if (mode === "disabled" || enabled.length === 0) {
      set({ indicatorOutputs: [], indicatorErrors: {}, indicatorBusy: false });
      return;
    }
    // snapshot the context this run is computed against; if it changes before the
    // (async) run resolves, the result is stale and must not overwrite new outputs
    const runSymbol = s.symbol;
    const runTimeframe = s.timeframe;
    const runConsolidation = s.consolidation;
    const runMode = mode;
    set({ indicatorBusy: true });
    try {
      const dataContext = await loadIndicatorDataContext(enabled, s.candles, runSymbol, runTimeframe);
      const { outputs, errors } = await runIndicators(mode, s.indicators, s.candles, runSymbol, runTimeframe, dataContext);
      const cur = get();
      // drop the result if a newer recompute superseded it OR the user switched context
      // (symbol / timeframe / consolidation / execution mode) while it was in flight
      if (
        seq !== recomputeSeq ||
        cur.symbol !== runSymbol ||
        cur.timeframe !== runTimeframe ||
        cur.consolidation !== runConsolidation ||
        cur.indicatorExecutionMode !== runMode
      ) {
        return;
      }
      // auto-disable any indicator that timed out: otherwise a chronically-hung script
      // re-spawns the worker on every ~150ms recompute (steady stall-and-respawn churn).
      const timedOut = enabled.filter((i) => errors[i.id] === "Indicator timed out");
      if (timedOut.length) {
        const ids = new Set(timedOut.map((i) => i.id));
        const indicators = cur.indicators.map((i) =>
          ids.has(i.id) ? { ...i, enabled: false, lastError: "Indicator timed out - disabled" } : i,
        );
        persistIndicators(indicators, cur.indicatorExecutionMode);
        set({ indicators, indicatorOutputs: outputs, indicatorErrors: errors, indicatorBusy: false });
        return;
      }
      set({ indicatorOutputs: outputs, indicatorErrors: errors, indicatorBusy: false });
    } catch {
      if (seq !== recomputeSeq) return;
      set({ indicatorBusy: false });
    }
  },

  // ----- interactive Anchored VWAP anchor picking (TradingView-style) -----
  // re-anchor an EXISTING instance (panel "Pick Anchor")
  beginIndicatorAnchorPick: (indicatorId) =>
    set({
      pendingAnchorIndicatorId: indicatorId,
      pendingAnchorTool: null,
      activeTool: "select",
      selectedDrawingId: null,
    }),
  // cancel either mode (re-anchor or new-placement)
  cancelIndicatorAnchorPick: () => set({ pendingAnchorIndicatorId: null, pendingAnchorTool: null }),
  setIndicatorAnchor: (indicatorId, anchorTime, anchorSymbol) => {
    const cur = get();
    const sym = anchorSymbol ?? cur.symbol;
    const indicators = cur.indicators.map((i) =>
      i.id === indicatorId
        ? {
            // write the anchor into THIS instance's inputs (override script defaults);
            // preserve any other inputs the user set. updatedAt + cleared error so the
            // row reflects the fresh anchor.
            ...i,
            inputs: { ...i.inputs, anchorTime, anchorSymbol: sym },
            updatedAt: Date.now(),
            lastError: null,
          }
        : i,
    );
    const errs = { ...cur.indicatorErrors };
    delete errs[indicatorId];
    set({ indicators, indicatorErrors: errs, pendingAnchorIndicatorId: null, pendingAnchorTool: null });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  // ----- indicator-management UI (legend / context menu / dialogs) -----
  setIndicatorsPanelOpen: (open) => set({ indicatorsPanelOpen: open }),
  setFootprintSettingsOpen: (open) => set({ footprintSettingsOpen: open }),
  setSettingsIndicatorId: (id) => set({ settingsIndicatorId: id }),
  setSourceIndicatorId: (id) => set({ sourceIndicatorId: id }),

  moveIndicator: (id, dir) => {
    const cur = get();
    const arr = cur.indicators.slice();
    const i = arr.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    set({ indicators: arr });
    persistIndicators(arr, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  duplicateIndicator: (id) => {
    const cur = get();
    const idx = cur.indicators.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const src = cur.indicators[idx];
    const copy: IndicatorInstance = {
      ...src,
      id: uid(),
      name: `${src.name} (copy)`,
      inputs: { ...src.inputs },
      visibility: src.visibility
        ? {
            ticks: { ...src.visibility.ticks },
            minutes: { ...src.visibility.minutes },
            hours: { ...src.visibility.hours },
            days: { ...src.visibility.days },
          }
        : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    };
    const indicators = [...cur.indicators.slice(0, idx + 1), copy, ...cur.indicators.slice(idx + 1)];
    set({ indicators });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  renameIndicator: (id, name) => {
    const cur = get();
    const clean = String(name).trim().slice(0, 64) || "Indicator";
    const indicators = cur.indicators.map((i) => (i.id === id ? { ...i, name: clean, updatedAt: Date.now() } : i));
    set({ indicators });
    persistIndicators(indicators, cur.indicatorExecutionMode);
  },

  setIndicatorVisibility: (id, visibility) => {
    const cur = get();
    const indicators = cur.indicators.map((i) => (i.id === id ? { ...i, visibility, updatedAt: Date.now() } : i));
    set({ indicators });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  resetIndicatorInputs: (id) => {
    const cur = get();
    const indicators = cur.indicators.map((i) => {
      if (i.id !== id) return i;
      const meta = parseIndicatorMeta(i.script);
      return { ...i, inputs: { ...meta.inputs }, visibility: undefined, updatedAt: Date.now() };
    });
    set({ indicators });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  // toolbar tool: arm placement mode -> the next candle click CREATES a fresh AVWAP
  beginAnchoredVwapPlacement: () =>
    set({
      pendingAnchorTool: "anchored-vwap",
      pendingAnchorIndicatorId: null,
      activeTool: "select",
      selectedDrawingId: null,
    }),
  addAnchoredVwapAt: (anchorTime, anchorSymbol) => {
    const cur = get();
    const sym = anchorSymbol ?? cur.symbol;
    // a brand-new, independent instance anchored at the clicked candle
    const base = makeIndicator(ANCHORED_VWAP_SCRIPT, true);
    const ind: IndicatorInstance = {
      ...base,
      name: anchoredVwapName(cur.indicators),
      inputs: { ...base.inputs, anchorTime, anchorSymbol: sym },
    };
    const indicators = [...cur.indicators, ind];
    set({ indicators, pendingAnchorTool: null });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },
  // delete every Anchored VWAP instance in one shot (single recompute)
  removeAllAnchoredVwaps: () => {
    const cur = get();
    const removed = new Set(cur.indicators.filter((i) => i.kind === "anchored-vwap").map((i) => i.id));
    if (removed.size === 0) return;
    const indicators = cur.indicators.filter((i) => i.kind !== "anchored-vwap");
    const errs = { ...cur.indicatorErrors };
    removed.forEach((id) => delete errs[id]);
    set({
      indicators,
      indicatorErrors: errs,
      pendingAnchorIndicatorId: removed.has(cur.pendingAnchorIndicatorId ?? "") ? null : cur.pendingAnchorIndicatorId,
      selectedIndicatorId: removed.has(cur.selectedIndicatorId ?? "") ? null : cur.selectedIndicatorId,
    });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  // ----------------------------------------------------------- chart drawings
  // (data-coord objects; no recompute - drawings don't feed indicators)
  setActiveTool: (tool) =>
    // Arming a drawing tool clears selection and cancels AVWAP placement; the
    // cursor keeps the current selection. Only one chart tool owns the pointer.
    set({
      activeTool: tool,
      selectedDrawingId: tool === "select" ? get().selectedDrawingId : null,
      selectedIndicatorId: null,
      pendingAnchorIndicatorId: null,
      pendingAnchorTool: null,
    }),
  addDrawing: (d) => {
    const cur = get();
    const drawings = [...cur.drawings, d];
    // creating one object reverts to the cursor and selects it (TradingView-style)
    set({
      drawings,
      selectedDrawingId: d.id,
      selectedIndicatorId: null,
      activeTool: "select",
      undoStack: pushHistory(cur.undoStack, cur.drawings),
      redoStack: [],
    });
    persistDrawings(drawings);
  },
  updateDrawing: (id, patch) => {
    const cur = get();
    const drawings = cur.drawings.map((d) =>
      d.id === id ? { ...d, ...patch, id: d.id, updatedAt: Date.now() } : d,
    );
    set({ drawings, undoStack: pushHistory(cur.undoStack, cur.drawings), redoStack: [] });
    persistDrawings(drawings);
  },
  removeDrawing: (id) => {
    const cur = get();
    const drawings = cur.drawings.filter((d) => d.id !== id);
    set({
      drawings,
      selectedDrawingId: cur.selectedDrawingId === id ? null : cur.selectedDrawingId,
      undoStack: pushHistory(cur.undoStack, cur.drawings),
      redoStack: [],
    });
    persistDrawings(drawings);
  },
  // selecting a drawing clears any AVWAP selection (one chart object selected at a time)
  selectDrawing: (id) => set({ selectedDrawingId: id, selectedIndicatorId: id ? null : get().selectedIndicatorId }),
  selectIndicator: (id) => set({ selectedIndicatorId: id, selectedDrawingId: id ? null : get().selectedDrawingId }),
  toggleDrawingVisible: (id) => {
    const cur = get();
    const drawings = cur.drawings.map((d) =>
      d.id === id ? { ...d, visible: !d.visible, updatedAt: Date.now() } : d,
    );
    set({ drawings, undoStack: pushHistory(cur.undoStack, cur.drawings), redoStack: [] });
    persistDrawings(drawings);
  },
  toggleDrawingLock: (id) => {
    const cur = get();
    const drawings = cur.drawings.map((d) =>
      d.id === id ? { ...d, locked: !d.locked, updatedAt: Date.now() } : d,
    );
    set({ drawings, undoStack: pushHistory(cur.undoStack, cur.drawings), redoStack: [] });
    persistDrawings(drawings);
  },
  clearDrawings: (symbol) => {
    const cur = get();
    const drawings = symbol ? cur.drawings.filter((d) => d.symbol !== symbol) : [];
    set({
      drawings,
      selectedDrawingId: null,
      undoStack: pushHistory(cur.undoStack, cur.drawings),
      redoStack: [],
    });
    persistDrawings(drawings);
  },
  setSnapMode: (mode) => set({ snapMode: mode }),
  // Undo/redo swap the whole `drawings` array between the two history stacks. Selection
  // is cleared if it points at a drawing that no longer exists in the restored set.
  undo: () => {
    const cur = get();
    if (cur.undoStack.length === 0) return;
    const undoStack = cur.undoStack.slice();
    const prev = undoStack.pop() as DrawingObject[];
    const redoStack = pushHistory(cur.redoStack, cur.drawings);
    const stillThere = cur.selectedDrawingId != null && prev.some((d) => d.id === cur.selectedDrawingId);
    set({ drawings: prev, undoStack, redoStack, selectedDrawingId: stillThere ? cur.selectedDrawingId : null });
    persistDrawings(prev);
  },
  redo: () => {
    const cur = get();
    if (cur.redoStack.length === 0) return;
    const redoStack = cur.redoStack.slice();
    const next = redoStack.pop() as DrawingObject[];
    const undoStack = pushHistory(cur.undoStack, cur.drawings);
    const stillThere = cur.selectedDrawingId != null && next.some((d) => d.id === cur.selectedDrawingId);
    set({ drawings: next, undoStack, redoStack, selectedDrawingId: stillThere ? cur.selectedDrawingId : null });
    persistDrawings(next);
  },
  setWindowRect: (id, rect) => {
    const windows = { ...get().windows, [id]: rect };
    set({ windows });
    persistWindows(windows);
  },

  reset: () => set({ candles: [], alerts: [], replay: null, replayActive: false }),
}));
