// Chart candle budget. The chart can hold a large history (default 15k); override via
// VITE_CHART_CANDLE_LIMIT. Custom indicators run on a SEPARATE, smaller window
// (indicators/types.ts MAX_CANDLES) so a big chart history can't trip the sandbox
// timeout — raising the chart limit does not raise the indicator limit.
export const CHART_CANDLE_LIMIT: number = (() => {
  const v = Number(import.meta.env.VITE_CHART_CANDLE_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 15000;
})();
