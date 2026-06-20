// Chart candle budgets, split by chart mode so the default load stays fast.
//
// Candle mode: a large history (default 15k) WITHOUT per-price footprint cells — a
// cells-free payload is a few MB instead of ~40MB, so it loads fast. Footprint mode
// genuinely needs the cells, so it requests a smaller window (full cells). Override
// the candle budget via VITE_CHART_CANDLE_LIMIT. Custom indicators use their own safety cap
// (indicators/types.ts MAX_CANDLES), currently aligned with this 15k candle-mode window.
export const CHART_CANDLE_LIMIT: number = (() => {
  const v = Number(import.meta.env.VITE_CHART_CANDLE_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 15000;
})();

// Footprint mode carries heavy per-price cells; cap its history so a switch to
// footprint stays responsive (you rarely need thousands of footprint bars at once).
export const FOOTPRINT_CANDLE_LIMIT: number = (() => {
  const v = Number(import.meta.env.VITE_FOOTPRINT_CANDLE_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3000;
})();

export type ChartMode = "footprint" | "candle";

// The snapshot request (limit + whether to include footprint cells) for a chart mode.
export function snapshotRequestForMode(mode: ChartMode): { limit: number; cells: boolean } {
  return mode === "footprint"
    ? { limit: FOOTPRINT_CANDLE_LIMIT, cells: true }
    : { limit: CHART_CANDLE_LIMIT, cells: false };
}
