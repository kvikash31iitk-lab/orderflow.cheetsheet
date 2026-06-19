// Custom-indicator type model. The rest of the app depends ONLY on these types
// (IndicatorOutput[] + IndicatorRunner) — never on a specific runner/sandbox impl,
// so the execution backend (worker / direct / future server) is swappable.
import type { FootprintCandle } from "../types/orderflow";

// ---- hard limits (shared by runners + the worker) ----
export const MAX_CANDLES = 3000;
export const MAX_OUTPUTS = 5000;
export const MAX_SCRIPT_LENGTH = 50000;
export const DEFAULT_TIMEOUT_MS = 250;

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
