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

  // fit the visible range + re-enable price autoscale (native APIs only; safe)
  const resetView = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
    chart.priceScale("right").applyOptions({ autoScale: true });
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
        // resolve the price/time under the cursor via native chart APIs (for Copy actions)
        let price: number | null = null;
        let time: number | null = null;
        const host = hostRef.current;
        const chart = chartRef.current;
        const series = seriesRef.current;
        if (host && chart && series) {
          const r = host.getBoundingClientRect();
          const t = chart.timeScale().coordinateToTime(e.clientX - r.left);
          time = typeof t === "number" ? t * 1000 : null;
          const p = series.coordinateToPrice(e.clientY - r.top);
          price = p == null ? null : (p as number);
        }
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
    </div>
  );
}
