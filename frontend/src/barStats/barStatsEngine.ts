// Pure Bar-Statistics computation + formatting. No React, no chart deps — given candles it
// returns one BarStatPoint per bar (memoize the call site). Every value is sourced from a
// real FootprintCandle field; unavailable metrics simply never appear here.
import type { FootprintCandle } from "../types/orderflow";
import {
  AVAILABLE_BAR_STAT_IDS,
  BAR_STAT_METRICS,
  BAR_STAT_METRIC_MAP,
  type BarStatMetricId,
  type BarStatPoint,
  type BarStatSettings,
} from "./types";

function dpFromRowSize(rowSize: number): number {
  const s = String(rowSize);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function computeBarStats(candles: readonly FootprintCandle[]): BarStatPoint[] {
  const out: BarStatPoint[] = [];
  for (const c of candles) {
    const vol = c.totalVolume;
    const values: Partial<Record<BarStatMetricId, number | null>> = {
      volume: vol,
      delta: c.delta,
      cumDelta: c.cumDelta,
      maxDelta: c.maxDelta,
      minDelta: c.minDelta,
      buyVolume: c.totalAskVolume,
      sellVolume: c.totalBidVolume,
      buyPct: vol > 0 ? (c.totalAskVolume / vol) * 100 : null,
      sellPct: vol > 0 ? (c.totalBidVolume / vol) * 100 : null,
      deltaPct: vol > 0 ? (c.delta / vol) * 100 : null,
      deltaPerVol: vol > 0 ? c.delta / vol : null,
      poc: c.poc,
      vwap: c.vwap,
      tickCount: c.tickCount,
      maxVolAtPrice: null,
      minVolAtPrice: null,
    };
    // Max/Min volume at a single price-level (only honest when the bar carries cells)
    if (c.cells && c.cells.length) {
      let mx = -Infinity;
      let mn = Infinity;
      for (const cell of c.cells) {
        if (cell.total > mx) mx = cell.total;
        if (cell.total < mn) mn = cell.total;
      }
      values.maxVolAtPrice = mx === -Infinity ? null : mx;
      values.minVolAtPrice = mn === Infinity ? null : mn;
    }
    out.push({ time: c.startTime, values, dp: dpFromRowSize(c.rowSize || 1) });
  }
  return out;
}

// Which structurally-available metrics actually carry usable data in the loaded bars. Re-aggregated
// timeframes drop fields like maxDelta/minDelta/vwap/tickCount from the payload entirely, so those
// metrics produce no finite value anywhere -> they come back false here and the pane can hide the row
// instead of rendering it blank. A legitimate 0 is finite and therefore counts as AVAILABLE; only
// null/undefined/NaN (or all-missing across every bar) counts as unavailable. Early-exits once every
// available metric has been seen, so the native-payload case is ~O(metrics), not O(bars × metrics).
export function computeBarStatAvailability(points: readonly BarStatPoint[]): Record<BarStatMetricId, boolean> {
  const avail = {} as Record<BarStatMetricId, boolean>;
  for (const m of BAR_STAT_METRICS) avail[m.id] = false;
  let remaining = AVAILABLE_BAR_STAT_IDS.length;
  for (let i = 0; i < points.length && remaining > 0; i++) {
    const values = points[i].values;
    for (const id of AVAILABLE_BAR_STAT_IDS) {
      if (avail[id]) continue;
      const v = values[id];
      if (v != null && Number.isFinite(v)) {
        avail[id] = true;
        remaining--;
      }
    }
  }
  return avail;
}

// compact magnitude: 999 / 1.5K / 120K / 1.2M
function compactNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (a >= 100_000) return Math.round(v / 1000) + "K";
  if (a >= 1000) return (v / 1000).toFixed(1) + "K";
  return String(Math.round(v));
}

// Format one cell's value for display, honouring number-format + percent precision.
export function formatBarStatValue(id: BarStatMetricId, value: number | null, s: BarStatSettings, dp: number): string {
  if (value == null || !Number.isFinite(value)) return "";
  const def = BAR_STAT_METRIC_MAP[id];
  const num = (n: number) => (s.numberFormat === "compact" ? compactNum(n) : String(Math.round(n)));
  switch (def.format) {
    case "volume":
    case "count":
      return num(value);
    case "delta":
      return (value > 0 ? "+" : "") + num(value);
    case "pct": {
      const t = value.toFixed(Math.max(0, Math.min(2, s.percentDecimals)));
      return (def.role === "signed" && value > 0 ? "+" : "") + t + "%";
    }
    case "ratio":
      return (value > 0 ? "+" : "") + value.toFixed(2);
    case "price":
      return value.toFixed(dp);
    default:
      return num(value);
  }
}
