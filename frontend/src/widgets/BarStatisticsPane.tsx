// Bar Statistics pane — a candle-aligned numeric grid in its own lightweight-charts sub-pane,
// time-synced to the main chart via chartSync (same one-way drive as CumDelta / DeltaHistogram).
// The grid itself is a custom-series canvas renderer (barStatsSeries); the metric ROW LABELS
// are a static DOM overlay on the left. Metric computation is memoised on the candle array.
import { useEffect, useMemo, useRef } from "react";
import { createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
import {
  BarStatsSeriesView,
  type BarStatsData,
  type BarStatsSeriesApi,
  type BarStatsSeriesOptions,
} from "../charts/barStatsSeries";
import { computeBarStats } from "../barStats/barStatsEngine";
import { BAR_STAT_METRIC_MAP, type BarStatMetricDef } from "../barStats/types";

function paneOptions(theme: "dark" | "light") {
  const base = lwcTheme(theme);
  return {
    ...base,
    // own time axis hidden (the main/lower pane shows it); keeps the canvas full-height so the
    // left label overlay aligns row-for-row. Grid hidden — the renderer draws its own row lines.
    timeScale: { ...base.timeScale, visible: false },
    grid: { horzLines: { visible: false }, vertLines: { visible: false } },
    crosshair: { horzLine: { visible: false } },
  };
}

export default function BarStatisticsPane() {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<BarStatsSeriesApi | null>(null);
  const candles = useStore((s) => s.candles);
  const theme = useStore((s) => s.theme);
  const settings = useStore((s) => s.barStatsSettings);
  const lastSymbolRef = useRef(useStore.getState().symbol);

  const enabled: BarStatMetricDef[] = useMemo(
    () => settings.enabled.map((id) => BAR_STAT_METRIC_MAP[id]).filter((d): d is BarStatMetricDef => !!d && d.available),
    [settings.enabled],
  );
  const points = useMemo(() => computeBarStats(candles), [candles]);

  // create chart + custom series once
  useEffect(() => {
    if (!ref.current) return;
    const st = useStore.getState();
    const chart = createChart(ref.current, { autoSize: true, ...paneOptions(st.theme) });
    const series = chart.addCustomSeries<BarStatsData, BarStatsSeriesOptions>(new BarStatsSeriesView(), {
      metrics: [],
      settings: st.barStatsSettings,
      theme: st.theme,
    });
    // blank price-scale labels (the constant value carries no meaning) — keeps a clean gutter
    series.applyOptions({ priceFormat: { type: "custom", minMove: 1, formatter: () => "" } });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.02, bottom: 0.02 } });
    chartRef.current = chart;
    seriesRef.current = series;
    registerChart("barstats", { chart, series });
    return () => {
      unregisterChart("barstats");
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // follow the global theme
  useEffect(() => {
    chartRef.current?.applyOptions(paneOptions(theme));
    seriesRef.current?.applyOptions({ theme });
  }, [theme]);

  // enabled metrics / settings -> series options (cheap; no setData)
  useEffect(() => {
    seriesRef.current?.applyOptions({ metrics: enabled, settings });
  }, [enabled, settings]);

  // candle metrics -> series data (strictly-ascending unique seconds, like the sibling panes)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const data: BarStatsData[] = [];
    let lastT = -Infinity;
    for (const p of points) {
      const t = Math.floor(p.time / 1000);
      if (t <= lastT) continue;
      lastT = t;
      data.push({ time: t as UTCTimestamp, point: p });
    }
    try {
      series.setData(data);
    } catch {
      /* ignore malformed series data */
    }
    const sym = useStore.getState().symbol;
    if (data.length && lastSymbolRef.current !== sym) {
      lastSymbolRef.current = sym;
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    }
  }, [points]);

  return (
    <div className="relative h-full w-full bg-terminal-bg">
      <div ref={ref} className="h-full w-full" />
      {/* static metric-name gutter, aligned row-for-row with the canvas grid */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[58px] flex-col border-r border-terminal-border bg-terminal-panel/85">
        {enabled.map((m) => (
          <div
            key={m.id}
            title={m.label}
            className="flex flex-1 items-center justify-end overflow-hidden border-b border-terminal-border/40 px-1.5 text-[9px] font-medium text-terminal-muted last:border-b-0"
          >
            {m.short}
          </div>
        ))}
      </div>
      {enabled.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-terminal-muted">
          No metrics enabled — open Bar Statistics settings
        </div>
      )}
    </div>
  );
}
