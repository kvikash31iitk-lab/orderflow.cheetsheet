import { ColorType } from "lightweight-charts";

// Shared layout/grid options for the lightweight-charts panels (CumDelta,
// DeltaHistogram) so they follow the global light/dark theme. Pass the result to
// createChart(...) and to chart.applyOptions(...) on theme change.
export function lwcTheme(theme: "dark" | "light") {
  const dark = theme === "dark";
  const bg = dark ? "#12161c" : "#ffffff";
  const text = dark ? "#6b7785" : "#6c757d";
  const grid = dark ? "#1f2630" : "#dee2e6";
  return {
    layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontSize: 10 },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: grid },
    rightPriceScale: { borderColor: grid },
  };
}
