// Custom-indicator type model. The rest of the app depends ONLY on these types
// (IndicatorOutput[] + IndicatorRunner) — never on a specific runner/sandbox impl,
// so the execution backend (worker / direct / future server) is swappable.
import type { FootprintCandle } from "../types/orderflow";

// ---- hard limits (shared by runners + the worker) ----
export const MAX_CANDLES = 3000;
export const MAX_OUTPUTS = 5000;
export const MAX_SCRIPT_LENGTH = 50000;
// Tight per-run sandbox budget for WARM runs (raised 250 -> 500 for headroom over the
// structured-clone of the candle payload). The O(n^2) history allocation in runtime.ts
// (see makeCtx) is the main false-timeout fix; this still bounds runaway/infinite loops.
export const DEFAULT_TIMEOUT_MS = 500;
// The FIRST run on a freshly-created sandbox worker also pays a one-time worker spin-up
// + JIT cost (measured ~600ms on a fast machine over 3000 real footprint candles, more
// on slow hardware) ON TOP of the script. Without a separate budget that cold run trips
// the 500ms ceiling and a normal indicator (e.g. Delta Spike) gets falsely auto-disabled
// the instant it's enabled. The first run gets this larger budget; once the worker has
// answered once it is "warm" and reverts to DEFAULT_TIMEOUT_MS.
export const COLD_START_TIMEOUT_MS = 2500;

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
  maxOutputs?: number;
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
