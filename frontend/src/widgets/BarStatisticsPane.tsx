// Bar Statistics pane — a candle-aligned numeric grid in its own lightweight-charts sub-pane,
// time-synced to the main chart via chartSync (same one-way drive as CumDelta / DeltaHistogram).
// The grid itself is a custom-series canvas renderer (barStatsSeries); the metric ROW LABELS
// are a static DOM overlay on the left. Metric computation is memoised on the candle array.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
import { useContextMenu } from "../components/TerminalContextMenu";
import BarStatsContextMenu from "./BarStatsContextMenu";
import {
  BarStatsSeriesView,
  type BarStatsData,
  type BarStatsSeriesApi,
  type BarStatsSeriesOptions,
} from "../charts/barStatsSeries";
import { computeBarStats, computeBarStatAvailability, formatBarStatValue } from "../barStats/barStatsEngine";
import { AVAILABLE_BAR_STAT_IDS, BAR_STAT_METRIC_MAP, type BarStatMetricDef, type BarStatMetricId } from "../barStats/types";

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

  const points = useMemo(() => computeBarStats(candles), [candles]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // structurally-supported enabled metrics, in row order
  const structural: BarStatMetricDef[] = useMemo(
    () => settings.enabled.map((id) => BAR_STAT_METRIC_MAP[id]).filter((d): d is BarStatMetricDef => !!d && d.available),
    [settings.enabled],
  );
  // availability is judged over the bars CURRENTLY ON SCREEN (re-aggregated timeframes omit
  // maxDelta/minDelta/vwap/tickCount, and even within one timeframe only some historical bars may
  // carry them). null = not computed yet -> show the normal rows so nothing flashes empty on load.
  const [availability, setAvailability] = useState<Record<BarStatMetricId, boolean> | null>(null);
  const availSigRef = useRef("");
  // recompute over the visible logical range; update React + the store ONLY when the available SET
  // actually flips (timeframe switch / panning across a data boundary) — never per pan/zoom frame.
  const recomputeAvailability = useCallback(() => {
    const chart = chartRef.current;
    const pts = pointsRef.current;
    if (!chart || pts.length === 0) return;
    const r = chart.timeScale().getVisibleLogicalRange();
    let from = Math.max(0, pts.length - 120); // sensible recent window until the chart reports a range
    let to = pts.length;
    if (r) {
      from = Math.floor(r.from);
      to = Math.ceil(r.to) + 1;
    }
    const a = computeBarStatAvailability(pts, from, to);
    let sig = "";
    for (const id of AVAILABLE_BAR_STAT_IDS) sig += a[id] ? "1" : "0";
    if (sig === availSigRef.current) return;
    availSigRef.current = sig;
    setAvailability(a);
    useStore.getState().setBarStatAvailability({ ...a });
  }, []);
  // rows actually drawn: drop metrics with no usable data on screen. Before availability is known
  // (initial / no data) keep the normal rows so the pane doesn't flash the empty state during load.
  const enabled: BarStatMetricDef[] = useMemo(
    () => (points.length === 0 || !availability ? structural : structural.filter((d) => availability[d.id])),
    [structural, availability, points.length],
  );

  const { menu, open, close } = useContextMenu<{ time: number | null; metricShort: string | null; valueStr: string | null }>();
  // resolve the metric row (from y) and the bar (from x) under the cursor for the right-click menu
  const onCtx = (e: MouseEvent) => {
    let time: number | null = null;
    let metricShort: string | null = null;
    let valueStr: string | null = null;
    const chart = chartRef.current;
    const host = ref.current;
    if (chart && host && enabled.length > 0) {
      const r = host.getBoundingClientRect();
      const t = chart.timeScale().coordinateToTime(e.clientX - r.left);
      if (typeof t === "number") {
        time = t * 1000;
        const pt = points.find((p) => Math.floor(p.time / 1000) === t);
        if (pt) {
          const row = Math.floor(((e.clientY - r.top) / r.height) * enabled.length);
          const m = enabled[Math.max(0, Math.min(enabled.length - 1, row))];
          const s = formatBarStatValue(m.id, pt.values[m.id] ?? null, settings, pt.dp);
          if (s) {
            metricShort = m.short;
            valueStr = s;
          }
        }
      }
    }
    open(e, { time, metricShort, valueStr });
  };

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
    // re-judge metric availability whenever the on-screen bar range changes (pan/zoom/scroll). The
    // callback is signature-guarded so this only triggers a React update when the available SET flips.
    chart.timeScale().subscribeVisibleLogicalRangeChange(recomputeAvailability);
    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(recomputeAvailability);
      } catch {
        /* chart already removed */
      }
      unregisterChart("barstats");
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [recomputeAvailability]);

  // follow the global theme
  useEffect(() => {
    chartRef.current?.applyOptions(paneOptions(theme));
    seriesRef.current?.applyOptions({ theme });
  }, [theme]);

  // enabled metrics / settings -> series options (cheap; no setData)
  useEffect(() => {
    seriesRef.current?.applyOptions({ metrics: enabled, settings });
  }, [enabled, settings]);

  // publish the row tally (enabled-&-supported vs actually-shown) so the pane HEADER can note when
  // some enabled metrics are hidden for the current visible range. Value-guarded (the pane never
  // reads barStatRowInfo) -> store updates only when a count changes, no render loop.
  const rowInfoRef = useRef({ total: -1, shown: -1 });
  useEffect(() => {
    const total = structural.length;
    const shown = enabled.length;
    if (total === rowInfoRef.current.total && shown === rowInfoRef.current.shown) return;
    rowInfoRef.current = { total, shown };
    useStore.getState().setBarStatRowInfo({ total, shown });
  }, [structural.length, enabled.length]);

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
    // data changed (new bars / timeframe / symbol) -> re-judge availability for the visible range
    recomputeAvailability();
  }, [points, recomputeAvailability]);

  return (
    <div className="relative h-full w-full bg-terminal-bg" onContextMenu={onCtx}>
      <div ref={ref} className="h-full w-full" />
      {menu && (
        <BarStatsContextMenu
          x={menu.x}
          y={menu.y}
          time={menu.time}
          metricShort={menu.metricShort}
          valueStr={menu.valueStr}
          onClose={close}
        />
      )}
      {/* static metric-name gutter, aligned row-for-row with the canvas grid. z-10 lifts it above
          the lightweight-charts canvases (which carry z-index 1/2 and would otherwise paint over
          it); a solid bg makes it a frozen header column (and cleanly hides the LWC logo corner). */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-[58px] flex-col border-r border-terminal-border bg-terminal-panel">
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
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-terminal-muted">
          {structural.length === 0
            ? "No metrics enabled — open Bar Statistics settings"
            : "No enabled statistics available for this timeframe"}
        </div>
      )}
    </div>
  );
}
