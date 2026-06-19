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
import type {
  IndicatorExecutionMode,
  IndicatorInstance,
  IndicatorOutput,
} from "../indicators/types";
import { runIndicators, disposeSandbox } from "../indicators/engine";
import { parseIndicatorMeta } from "../indicators/runtime";
import { DELTA_SPIKE_SCRIPT, ANCHORED_VWAP_SCRIPT } from "../indicators/examples";

export const DEFAULT_SETTINGS: FootprintSettings = {
  tickMultiplier: 1,
  imbalanceRatio: 3.0,
  imbalanceMinVolume: 50,
  showVwap: true,
  showSdBands: true,
  showPoc: true,
  showImbalances: true,
  showBadges: true,
  showFills: true,
  showThinCandle: true,
  lockBlockSize: false,
};

const MAX_CANDLES = 3000;
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
          const m = migrateAnchoredVwap(i);
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
  // id of the indicator currently waiting for a chart-click anchor (null = not picking)
  pendingAnchorIndicatorId: string | null;

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
  setBlockSizeModalOpen: (open: boolean) => void;
  ingest: (msg: ServerMessage) => void;
  loadSnapshot: (symbol: string, timeframe: string, candles: FootprintCandle[]) => void;
  loadLiveSnapshot: () => void;
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

export const useStore = create<State>((set, get) => ({
  source: "truedata",
  symbol: "NIFTY-I",
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
  chartDisplayMode: "footprint",
  theme: "dark",
  settings: DEFAULT_SETTINGS,
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

  setSource: (src) => {
    // Use the CANONICAL upper-case symbol: the backend emits live candles as
    // "6E.V.0", and the store's candle filter is case-sensitive — a lowercase
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
  setChartDisplayMode: (m) => set({ chartDisplayMode: m }),
  toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),
  setSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
  setBlockSizeModalOpen: (open) => set({ blockSizeModalOpen: open }),

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
    const { symbol, timeframe, consolidation } = get();
    const rowSize = consolidatedRowSize(symbol, consolidation);
    api
      .footprints(symbol, timeframe, rowSize)
      .then((r) => {
        // ignore if the user moved on, a replay restarted, or consolidation changed meanwhile
        const s = get();
        const rs = consolidatedRowSize(s.symbol, s.consolidation);
        if (s.replayActive || s.symbol !== symbol || s.timeframe !== timeframe || rowSize !== rs) return;
        set({ candles: r.candles.slice(-MAX_CANDLES) });
        scheduleRecompute();
      })
      .catch(() => {});
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
    const ind = makeIndicator(script, true);
    const indicators = [...get().indicators, ind];
    set({ indicators });
    persistIndicators(indicators, get().indicatorExecutionMode);
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
        ? // re-enabling clears any stale error (e.g. a prior "Indicator timed out —
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
    // old mode) and clear stale overlays immediately — same discipline as a symbol switch
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
      const { outputs, errors } = await runIndicators(mode, s.indicators, s.candles, runSymbol, runTimeframe);
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
          ids.has(i.id) ? { ...i, enabled: false, lastError: "Indicator timed out — disabled" } : i,
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
  beginIndicatorAnchorPick: (indicatorId) => set({ pendingAnchorIndicatorId: indicatorId }),
  cancelIndicatorAnchorPick: () => set({ pendingAnchorIndicatorId: null }),
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
    set({ indicators, indicatorErrors: errs, pendingAnchorIndicatorId: null });
    persistIndicators(indicators, cur.indicatorExecutionMode);
    scheduleRecompute(50);
  },

  reset: () => set({ candles: [], alerts: [], replay: null, replayActive: false }),
}));
