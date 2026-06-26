import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
import { Crosshair, Pencil } from "lucide-react";
import { createDrawingController } from "../drawings/drawingController";
import { toolDef } from "../drawings/types";
import DrawingSelectionToolbar from "../widgets/DrawingSelectionToolbar";
import AvwapSelectionToolbar from "../widgets/AvwapSelectionToolbar";
import IndicatorLegend from "../widgets/IndicatorLegend";
import IndicatorContextMenu from "../widgets/IndicatorContextMenu";
import DrawingObjectMenu from "../widgets/DrawingObjectMenu";
import AvwapObjectMenu from "../widgets/AvwapObjectMenu";
import FootprintContextMenu from "../dashboard/FootprintContextMenu";
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  FootprintSeriesView,
  type FootprintData,
  type FootprintSeriesApi,
  type FootprintSeriesOptions,
} from "./footprintSeries";
import type { FootprintCandle } from "../types/orderflow";

const toData = (candles: FootprintCandle[]): FootprintData[] =>
  candles.map((c) => ({ time: Math.floor(c.startTime / 1000) as UTCTimestamp, candle: c }));

export default function FootprintChart() {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<FootprintSeriesApi | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const drawingControllerRef = useRef<ReturnType<typeof createDrawingController> | null>(null);

  const candles = useStore((s) => s.candles);
  const footprintMode = useStore((s) => s.footprintMode);
  const chartDisplayMode = useStore((s) => s.chartDisplayMode);
  const theme = useStore((s) => s.theme);
  const fills = useStore((s) => s.fills);
  const positions = useStore((s) => s.positions);
  const symbol = useStore((s) => s.symbol);
  const settings = useStore((s) => s.settings);
  const symbolConfigs = useStore((s) => s.symbolConfigs);
  const setSettings = useStore((s) => s.setSettings);
  const indicatorOutputs = useStore((s) => s.indicatorOutputs);
  const pendingAnchorId = useStore((s) => s.pendingAnchorIndicatorId);
  const pendingAnchorTool = useStore((s) => s.pendingAnchorTool);
  const cancelAnchorPick = useStore((s) => s.cancelIndicatorAnchorPick);
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const lastSymbolRef = useRef(symbol);
  // right-click footprint context menu — cursor position + the price/time under the click
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; price: number | null; time: number | null } | null>(null);
  // right-click directly on a chart object (drawing / Anchored VWAP / indicator overlay) — opens an
  // object-specific menu. AVWAP carries the resolved anchor + nearest value + center target.
  const [objMenu, setObjMenu] = useState<
    | { kind: "drawing"; id: string; x: number; y: number }
    | {
        kind: "avwap";
        id: string;
        x: number;
        y: number;
        anchorTime: number | null;
        anchorPrice: number | null;
        valueHere: number | null;
        centerTime: number | null;
      }
    | { kind: "indicator"; id: string; x: number; y: number }
    | null
  >(null);

  // fit the visible range + re-enable price autoscale (native APIs only; safe)
  const resetView = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
    chart.priceScale("right").applyOptions({ autoScale: true });
  };

  // center the visible range on a candle time (used by the AVWAP "Center on anchor" action). Native
  // setVisibleLogicalRange only — no scroll hacks, no autoscale change. No-op if the time isn't loaded.
  const centerOnTime = (time: number | null) => {
    const chart = chartRef.current;
    if (!chart || time == null) return;
    const cs = useStore.getState().candles;
    const idx = cs.findIndex((c) => c.startTime === time);
    if (idx < 0) return;
    const vr = chart.timeScale().getVisibleLogicalRange();
    const half = vr ? (vr.to - vr.from) / 2 : 30;
    chart.timeScale().setVisibleLogicalRange({ from: idx - half, to: idx + half });
  };

  // init the chart + custom series once
  useEffect(() => {
    if (!hostRef.current) return;
    const s = useStore.getState();
    const chart = createChart(hostRef.current, {
      autoSize: true,
      ...lwcTheme(s.theme),
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { ...lwcTheme(s.theme).timeScale, barSpacing: 110, rightOffset: 4 },
    });
    const series = chart.addCustomSeries<FootprintData, FootprintSeriesOptions>(new FootprintSeriesView(), {
      displayMode: s.footprintMode,
      chartMode: s.chartDisplayMode,
      footprintMinBarSpacing: 85,
      palette: s.theme === "light" ? LIGHT_PALETTE : DARK_PALETTE,
      fills: s.fills,
      settings: s.settings,
      indicatorOutputs: s.indicatorOutputs,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    series.setData(toData(s.candles));
    registerChart("main", { chart, series });

    // interactive drawing layer: attaches a series primitive + native pointer/keyboard
    // handlers to the chart host (create / select / move / resize / delete). Disables
    // chart pan while a tool is armed or a gesture is in progress; restores it after.
    const drawingController = createDrawingController({ host: hostRef.current, chart, series });
    drawingControllerRef.current = drawingController;
    // dev-only hit-zone diagnostic for deterministic verification (data point -> chart pixel).
    // import.meta.env.DEV is false in production builds, so Vite drops this entirely.
    if (import.meta.env.DEV) {
      (window as unknown as { __vikingsChart?: unknown }).__vikingsChart = {
        dataToPx: (time: number, price: number) => drawingController.dataToPx({ time, price }),
      };
    }

    // click-to-anchor: acts only while a placement mode is active. Two modes:
    //  - pendingAnchorTool "anchored-vwap": CREATE a new AVWAP at the clicked candle.
    //  - pendingAnchorIndicatorId: RE-ANCHOR that existing instance.
    // Reads the LATEST store state at click time (getState) so the once-subscribed
    // handler never holds a stale pending id / candle list.
    const onChartClick = (param: MouseEventParams) => {
      const st = useStore.getState();
      const toolMode = st.pendingAnchorTool === "anchored-vwap";
      const pendingId = st.pendingAnchorIndicatorId;
      if (!toolMode && !pendingId) return;
      // resolve the clicked time -> epoch ms (param.time when on a bar, else from x)
      let ms: number | null = null;
      if (typeof param.time === "number") {
        ms = param.time * 1000;
      } else if (param.point) {
        const t = chart.timeScale().coordinateToTime(param.point.x);
        if (typeof t === "number") ms = t * 1000;
      }
      if (ms == null) return; // unresolved click -> keep placement mode active, do nothing
      const cs = st.candles;
      if (!cs.length) return;
      // map to the nearest candle by startTime
      let nearest = cs[0];
      let best = Math.abs(cs[0].startTime - ms);
      for (let i = 1; i < cs.length; i++) {
        const d = Math.abs(cs[i].startTime - ms);
        if (d < best) {
          best = d;
          nearest = cs[i];
        }
      }
      if (toolMode) {
        st.addAnchoredVwapAt(nearest.startTime, st.symbol);
      } else if (pendingId) {
        st.setIndicatorAnchor(pendingId, nearest.startTime, st.symbol);
      }
    };
    chart.subscribeClick(onChartClick);

    return () => {
      chart.unsubscribeClick(onChartClick);
      drawingController.dispose();
      drawingControllerRef.current = null;
      unregisterChart("main");
      entryLineRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(toData(candles));
    if (candles.length > 0 && lastSymbolRef.current !== symbol) {
      lastSymbolRef.current = symbol;
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles, symbol]);

  // footprint/candle display options -> force a redraw (Task 4)
  useEffect(() => {
    seriesRef.current?.applyOptions({ displayMode: footprintMode, chartMode: chartDisplayMode });
    chartRef.current?.applyOptions({});
  }, [footprintMode, chartDisplayMode]);

  useEffect(() => {
    seriesRef.current?.applyOptions({ fills });
  }, [fills]);

  // custom-indicator overlays -> redraw (price/custom-pane outputs draw here)
  useEffect(() => {
    seriesRef.current?.applyOptions({ indicatorOutputs });
  }, [indicatorOutputs]);

  // settings (tick grouping, imbalance thresholds, cluster/POC options...) -> redraw.
  // EDGE: Last Value drives the native price-line + last-value label; Name drives the
  // series title label. Both are native lightweight-charts series options.
  useEffect(() => {
    seriesRef.current?.applyOptions({
      settings,
      lastValueVisible: settings.showLastValue,
      priceLineVisible: settings.showLastValue,
      title: settings.showSeriesName ? symbol : "",
    });
  }, [settings, symbol]);

  // seed the per-symbol imbalance defaults (CME futures are tuned looser than NSE
  // index futures) when the symbol or the fetched config table changes. The user
  // can still override these afterwards via the Settings modal until they switch
  // symbols again.
  useEffect(() => {
    const cfg = symbolConfigs[symbol.toUpperCase()];
    if (cfg) {
      setSettings({ imbalanceRatio: cfg.imbalance_ratio, imbalanceMinVolume: cfg.min_vol_for_highlight });
    }
  }, [symbol, symbolConfigs, setSettings]);

  // theme sync: chart layout + custom-series palette (Task 5)
  useEffect(() => {
    chartRef.current?.applyOptions(lwcTheme(theme));
    seriesRef.current?.applyOptions({ palette: theme === "light" ? LIGHT_PALETTE : DARK_PALETTE });
  }, [theme]);

  // average-entry price line via native price line (Task 5a)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (entryLineRef.current) {
      series.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    const pos = positions.find((p) => p.symbol === symbol);
    if (pos && pos.qty !== 0 && pos.entryPrice != null) {
      const long = pos.qty > 0;
      const pal = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
      // read rowSize via getState so live candle ticks don't re-create the line
      const dp = (useStore.getState().candles[0]?.rowSize ?? 1) < 1 ? 2 : 0;
      entryLineRef.current = series.createPriceLine({
        price: pos.entryPrice,
        color: long ? pal.buyHi : pal.sellHi,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${long ? "L" : "S"} @ ${pos.entryPrice.toFixed(dp)}`,
      });
    }
  }, [positions, symbol, theme]);

  return (
    <div
      className="relative h-full w-full"
      onContextMenu={(e) => {
        // open OUR menu only inside the chart area; right-click elsewhere keeps the browser menu
        e.preventDefault();
        const host = hostRef.current;
        const chart = chartRef.current;
        const series = seriesRef.current;
        if (!host) return;
        const r = host.getBoundingClientRect();
        const local = { x: e.clientX - r.left, y: e.clientY - r.top };
        // 1) directly on a chart object? open an object-specific menu (drawing topmost, then AVWAP).
        // Right-click only selects + opens the menu — it never starts a gesture (the pointer
        // controller ignores button !== 0) and never pans/zooms/places an order.
        const hit = drawingControllerRef.current?.pickObjectAt(local);
        if (hit?.drawing) {
          useStore.getState().selectDrawing(hit.drawing.id);
          setCtxMenu(null);
          setObjMenu({ kind: "drawing", id: hit.drawing.id, x: e.clientX, y: e.clientY });
          return;
        }
        if (hit?.avwapId) {
          // resolve the anchor time/price + the AVWAP value nearest the cursor from the plotted line
          const st = useStore.getState();
          const ind = st.indicators.find((i) => i.id === hit.avwapId);
          const lineOut = st.indicatorOutputs.find(
            (o) => o.type === "line" && o.indicatorId === hit.avwapId && (o.pane ?? "price") === "price",
          );
          const anchorTime = ind ? Number(ind.inputs.anchorTime ?? 0) || null : null;
          let anchorPrice: number | null = null;
          let valueHere: number | null = null;
          let centerTime: number | null = null;
          if (lineOut && lineOut.type === "line" && lineOut.points.length) {
            centerTime = lineOut.points[0].time;
            anchorPrice = lineOut.points[0].value; // AVWAP value at the anchor
            const ct = chart ? chart.timeScale().coordinateToTime(local.x) : null;
            const cursorMs = typeof ct === "number" ? ct * 1000 : null;
            if (cursorMs != null) {
              let best = lineOut.points[0];
              let bd = Math.abs(best.time - cursorMs);
              for (const p of lineOut.points) {
                const d = Math.abs(p.time - cursorMs);
                if (d < bd) {
                  bd = d;
                  best = p;
                }
              }
              valueHere = best.value;
            }
          }
          st.selectIndicator(hit.avwapId);
          setCtxMenu(null);
          setObjMenu({ kind: "avwap", id: hit.avwapId, x: e.clientX, y: e.clientY, anchorTime, anchorPrice, valueHere, centerTime });
          return;
        }
        if (hit?.indicatorId) {
          // a non-AVWAP indicator overlay (line / marker / zone) -> its existing menu (no select)
          setCtxMenu(null);
          setObjMenu({ kind: "indicator", id: hit.indicatorId, x: e.clientX, y: e.clientY });
          return;
        }
        // 2) empty chart space -> the existing footprint menu, with price/time under the cursor
        let price: number | null = null;
        let time: number | null = null;
        if (chart && series) {
          const t = chart.timeScale().coordinateToTime(local.x);
          time = typeof t === "number" ? t * 1000 : null;
          const p = series.coordinateToPrice(local.y);
          price = p == null ? null : (p as number);
        }
        setObjMenu(null);
        setCtxMenu({ x: e.clientX, y: e.clientY, price, time });
      }}
    >
      <div ref={hostRef} data-testid="footprint-chart" className="absolute inset-0" />
      {candles.length === 0 && (
        // loading / empty overlay so a large snapshot (deep history can be slow to
        // fetch) shows progress instead of a blank chart
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded border border-terminal-border bg-terminal-panel/90 px-4 py-2 text-xs text-terminal-muted shadow-lg">
            Loading {symbol}…
          </div>
        </div>
      )}
      <IndicatorLegend />
      <DrawingSelectionToolbar />
      <AvwapSelectionToolbar />
      {activeTool !== "select" && (
        // drawing-tool armed: prompt + Esc/Cancel. pointer-events-none wrapper so the
        // chart still receives the drag; only the banner itself is interactive.
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded border border-flow-delta/60 bg-terminal-panel/95 px-3 py-1.5 text-xs text-terminal-text shadow-lg shadow-black/40">
            <Pencil size={13} className="text-flow-delta" />
            <span>{toolDef(activeTool)?.label ?? "Drawing"} — drag on the chart · Esc to cancel</span>
            <button
              onClick={() => setActiveTool("select")}
              className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted hover:bg-terminal-border"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {(pendingAnchorId || pendingAnchorTool) && (
        // pointer-events-none wrapper so chart clicks pass through; only the small
        // banner (incl. Cancel) is clickable.
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded border border-flow-exhaustion/60 bg-terminal-panel/95 px-3 py-1.5 text-xs text-terminal-text shadow-lg shadow-black/40">
            <Crosshair size={13} className="text-flow-exhaustion" />
            <span>Click a candle to anchor Anchored VWAP</span>
            <button
              onClick={cancelAnchorPick}
              className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted hover:bg-terminal-border"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {ctxMenu && (
        <FootprintContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          price={ctxMenu.price}
          time={ctxMenu.time}
          onResetView={resetView}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {objMenu?.kind === "drawing" && (
        <DrawingObjectMenu drawingId={objMenu.id} x={objMenu.x} y={objMenu.y} onClose={() => setObjMenu(null)} />
      )}
      {objMenu?.kind === "avwap" && (
        <AvwapObjectMenu
          indicatorId={objMenu.id}
          x={objMenu.x}
          y={objMenu.y}
          anchorTime={objMenu.anchorTime}
          anchorPrice={objMenu.anchorPrice}
          valueHere={objMenu.valueHere}
          onCenter={() => centerOnTime(objMenu.centerTime)}
          onClose={() => setObjMenu(null)}
        />
      )}
      {objMenu?.kind === "indicator" && (
        <IndicatorContextMenu indicatorId={objMenu.id} x={objMenu.x} y={objMenu.y} onClose={() => setObjMenu(null)} />
      )}
    </div>
  );
}
