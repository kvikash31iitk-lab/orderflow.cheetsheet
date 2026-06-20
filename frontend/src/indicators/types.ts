// Custom-indicator type model. The rest of the app depends ONLY on these types
// (IndicatorOutput[] + IndicatorRunner) - never on a specific runner/sandbox impl,
// so the execution backend (worker / direct / future server) is swappable.
import type { FootprintCandle } from "../types/orderflow";

// ---- hard limits (shared by runners + the worker) ----
export const MAX_CANDLES = 15000;
export const MAX_OUTPUTS = 20000;
// Raised from 50000 to fit faithful, user-readable ports of large TradingView Pine
// indicators (e.g. "SC1 1604 V3 Pine Parity" ~70k chars; the Pine source is ~87k).
// This is an anti-abuse guard, not a transport limit -- scripts live in localStorage
// and cross to the worker via structured clone, both of which handle 100k+ strings.
export const MAX_SCRIPT_LENGTH = 200000;
// Per-run sandbox budget for WARM runs. The indicator window now matches the deep
// candle-mode chart history (15k), so this allows legitimate institutional scripts
// to process full history while still bounding runaway/infinite loops.
export const DEFAULT_TIMEOUT_MS = 1500;
// The FIRST run on a freshly-created sandbox worker also pays worker spin-up,
// structured-clone, and JIT costs. Give cold runs more room; warm runs revert to
// DEFAULT_TIMEOUT_MS after the first worker response.
export const COLD_START_TIMEOUT_MS = 5000;

export type IndicatorExecutionMode = "sandbox" | "direct" | "disabled";

export interface IndicatorInstance {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  inputs: Record<string, number | string | boolean>;
  overlay: boolean;
  createdAt: number;
  updatedAt: number;
  lastError?: string | null;
  // coarse classification derived from the script (e.g. "anchored-vwap") so the panel
  // can offer tool-specific UI (anchor picking) without string-matching the name.
  kind?: string;
}

export interface IndicatorRunRequest {
  indicator: IndicatorInstance;
  candles: FootprintCandle[];
  symbol: string;
  timeframe: string;
  dataContext?: IndicatorDataContext;
  maxOutputs?: number;
}

export interface IndicatorDataContext {
  footprints?: Record<string, FootprintCandle[]>;
  securities?: Record<string, FootprintCandle[]>;
  status?: Record<string, IndicatorDataStatus>;
}

export interface IndicatorDataStatus {
  ok: boolean;
  candles: number;
  error?: string;
}

export type IndicatorPane = "price" | "delta" | "cumDelta" | "custom";

export interface LinePoint {
  time: number; // epoch ms (candle.startTime)
  value: number;
}

export type IndicatorOutput =
  | {
      type: "line";
      indicatorId: string;
      id: string;
      points: LinePoint[];
      color: string;
      width?: number;
      opacity?: number;
      pane?: IndicatorPane;
    }
  | {
      type: "shape";
      indicatorId: string;
      id: string;
      time: number;
      price: number;
      text?: string;
      color: string;
      position?: "above" | "below" | "price";
    }
  | {
      type: "zone";
      indicatorId: string;
      id: string;
      fromTime: number;
      toTime: number;
      low: number;
      high: number;
      color: string;
      opacity?: number;
    }
  | {
      type: "histogram";
      indicatorId: string;
      id: string;
      points: { time: number; value: number; color?: string }[];
      pane: "delta" | "cumDelta" | "custom";
    };

export interface IndicatorRunResult {
  ok: boolean;
  outputs: IndicatorOutput[];
  error?: string;
  runtimeMs?: number;
}

// The single abstraction the app talks to. DirectRunner / SandboxRunner / a future
// BackendRunner all implement this, so the store + charts never change when the
// execution strategy changes.
export interface IndicatorRunner {
  run(request: IndicatorRunRequest): Promise<IndicatorRunResult>;
}
