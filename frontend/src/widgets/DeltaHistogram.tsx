import { useEffect, useRef, type MouseEvent } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
import { useContextMenu } from "../components/TerminalContextMenu";
import DeltaPaneMenu from "./DeltaPaneMenu";
import type { IndicatorOutput } from "../indicators/types";

export default function DeltaHistogram({ onHide }: { onHide?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const dataRef = useRef<{ time: number; value: number }[]>([]);
  const candles = useStore((s) => s.candles);
  const theme = useStore((s) => s.theme);
  const indicatorOutputs = useStore((s) => s.indicatorOutputs);
  const overlaysRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const lastSymbolRef = useRef(useStore.getState().symbol);
  const { menu, open, close } = useContextMenu<{ time: number | null; value: number | null }>();

  // resolve the bar under the cursor (value + time) for the right-click menu
  const onCtx = (e: MouseEvent) => {
    let time: number | null = null;
    let value: number | null = null;
    const chart = chartRef.current;
    const host = ref.current;
    if (chart && host) {
      const logical = chart.timeScale().coordinateToLogical(e.clientX - host.getBoundingClientRect().left);
      if (logical != null) {
        const d = dataRef.current[Math.round(logical as number)];
        if (d) {
          time = d.time * 1000;
          value = d.value;
        }
      }
    }
    open(e, { time, value });
  };

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { autoSize: true, ...lwcTheme(useStore.getState().theme) });
    const series = chart.addHistogramSeries({ priceFormat: { type: "volume" } });
    chartRef.current = chart;
    seriesRef.current = series;
    // sync target for the main chart's time scale + crosshair
    registerChart("histogram", {
      chart,
      series,
      valueAt: (t) => dataRef.current.find((d) => d.time === t)?.value,
    });
    return () => {
      unregisterChart("histogram");
      chart.remove();
      overlaysRef.current.clear(); // series invalidated by chart.remove()
    };
  }, []);

  // render delta-pane indicator LINES as managed overlay series on this sub-chart
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const lines = indicatorOutputs.filter(
      (o): o is Extract<IndicatorOutput, { type: "line" }> => o.type === "line" && o.pane === "delta",
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
        if (t <= lastT) continue;
        lastT = t;
        pts.push({ time: t as UTCTimestamp, value: p.value });
      }
      try {
        series.setData(pts);
      } catch {
        /* ignore malformed series data */
      }
    }
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
      value: c.delta,
      color: c.delta >= 0 ? "#16c172" : "#ef4d63",
    }));
    dataRef.current = data;
    seriesRef.current.setData(data);

    const currentSymbol = useStore.getState().symbol;
    if (candles.length > 0 && lastSymbolRef.current !== currentSymbol) {
      lastSymbolRef.current = currentSymbol;
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    }
  }, [candles]);

  return (
    <div className="relative h-full w-full" onContextMenu={onCtx}>
      <div ref={ref} className="h-full w-full" />
      {menu && (
        <DeltaPaneMenu
          x={menu.x}
          y={menu.y}
          time={menu.time}
          value={menu.value}
          valueLabel="Δ"
          onResetScale={() => chartRef.current?.priceScale("right").applyOptions({ autoScale: true })}
          onHide={onHide}
          hideLabel="Hide Delta Histogram"
          onClose={close}
        />
      )}
    </div>
  );
}
