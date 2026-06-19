import { useEffect, useRef } from "react";
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
import type { IndicatorOutput } from "../indicators/types";

export default function CumDelta() {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const dataRef = useRef<{ time: number; value: number }[]>([]);
  const candles = useStore((s) => s.candles);
  const theme = useStore((s) => s.theme);
  const indicatorOutputs = useStore((s) => s.indicatorOutputs);
  const overlaysRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const lastSymbolRef = useRef(useStore.getState().symbol);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { autoSize: true, ...lwcTheme(useStore.getState().theme) });
    const series = chart.addLineSeries({
      color: "#2f81f7",
      lineWidth: 2,
      priceLineStyle: LineStyle.Dotted,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    registerChart("cumdelta", {
      chart,
      series,
      valueAt: (t) => dataRef.current.find((d) => d.time === t)?.value,
    });
    return () => {
      unregisterChart("cumdelta");
      chart.remove();
      overlaysRef.current.clear(); // series invalidated by chart.remove()
    };
  }, []);

  // render cumDelta-pane indicator LINES as managed overlay series on this sub-chart
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const lines = indicatorOutputs.filter(
      (o): o is Extract<IndicatorOutput, { type: "line" }> => o.type === "line" && o.pane === "cumDelta",
    );
    const seen = new Set<string>();
    for (const o of lines) {
      seen.add(o.id);
      let series = overlaysRef.current.get(o.id);
      if (!series) {
        series = chart.addLineSeries({
          // default 2 to match the price-pane line renderer (footprintSeries)
          lineWidth: Math.max(1, Math.min(4, Math.round(o.width ?? 2))) as LineWidth,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        overlaysRef.current.set(o.id, series);
      }
      series.applyOptions({ color: o.color });
      const pts: { time: UTCTimestamp; value: number }[] = [];
      let lastT = -Infinity;
      for (const p of o.points) {
        if (!Number.isFinite(p.value)) continue;
        const t = Math.floor(p.time / 1000);
        if (t <= lastT) continue; // lightweight-charts needs strictly ascending unique times
        lastT = t;
        pts.push({ time: t as UTCTimestamp, value: p.value });
      }
      try {
        series.setData(pts);
      } catch {
        /* ignore malformed series data */
      }
    }
    // drop overlays whose output disappeared (indicator removed/disabled/symbol switch)
    for (const [id, series] of overlaysRef.current) {
      if (!seen.has(id)) {
        try {
          chart.removeSeries(series);
        } catch {
          /* already gone */
        }
        overlaysRef.current.delete(id);
      }
    }
  }, [indicatorOutputs]);

  // follow the global light/dark theme
  useEffect(() => {
    chartRef.current?.applyOptions(lwcTheme(theme));
  }, [theme]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = candles.map((c) => ({
      time: Math.floor(c.startTime / 1000) as UTCTimestamp,
      value: c.cumDelta,
    }));
    dataRef.current = data;
    seriesRef.current.setData(data);

    const currentSymbol = useStore.getState().symbol;
    if (candles.length > 0 && lastSymbolRef.current !== currentSymbol) {
      lastSymbolRef.current = currentSymbol;
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    }
  }, [candles]);

  return <div ref={ref} className="h-full w-full" />;
}
