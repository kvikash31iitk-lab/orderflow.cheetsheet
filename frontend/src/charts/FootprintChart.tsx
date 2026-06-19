import { useEffect, useRef } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store/useStore";
import { lwcTheme } from "../lib/chartTheme";
import { registerChart, unregisterChart } from "../lib/chartSync";
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
  const lastSymbolRef = useRef(symbol);

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
    return () => {
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

  // settings (tick grouping, imbalance thresholds, indicator toggles) -> redraw
  useEffect(() => {
    seriesRef.current?.applyOptions({ settings });
  }, [settings]);

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
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}
