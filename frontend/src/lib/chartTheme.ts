import { ColorType } from "lightweight-charts";
import { istCrosshairFormatter, istTickFormatter } from "./time";

// Shared layout/grid options for the lightweight-charts panels (main chart, CumDelta,
// DeltaHistogram) so they follow the global light/dark theme AND render times in IST.
// Pass the result to createChart(...) and to chart.applyOptions(...) on theme change.
export function lwcTheme(theme: "dark" | "light") {
  const dark = theme === "dark";
  const bg = dark ? "#12161c" : "#ffffff";
  const text = dark ? "#6b7785" : "#6c757d";
  const grid = dark ? "#1f2630" : "#dee2e6";
  return {
    layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontSize: 10 },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    // IST axis ticks + IST crosshair label (display only; data stays epoch-UTC)
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: grid, tickMarkFormatter: istTickFormatter },
    // fixed-floor gutter so every synced pane (main / CVD / histogram / bar-stats) shares one
    // right-axis width -> their bars line up column-for-column.
    rightPriceScale: { borderColor: grid, minimumWidth: 64 },
    localization: { timeFormatter: istCrosshairFormatter },
  };
}
