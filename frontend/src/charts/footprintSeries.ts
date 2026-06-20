// Footprint as a lightweight-charts v4 Custom Series Plugin.
//
// The native chart owns the time axis, price axis, crosshair, zoom/pan and
// autoscale; this renderer only paints the IN-PANE content: footprint cells (or
// candlesticks), POC, imbalance highlights, signal badges, VWAP + SD bands, and
// execution fill markers — using the standard 2D canvas context.
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type ISeriesApi,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type SeriesPartialOptions,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Fill, FootprintCandle, FootprintMode, FootprintSettings } from "../types/orderflow";
import type { IndicatorOutput } from "../indicators/types";

export type ChartMode = "footprint" | "candle";

// one data point per candle; `candle` carries the full footprint payload
export interface FootprintData extends CustomData<Time> {
  candle: FootprintCandle;
}

export interface FootprintPalette {
  buy: string;
  buyHi: string;
  sell: string;
  sellHi: string;
  neutral: string;
  text: string;
  poc: string;
  lpSup: string;
  lpRes: string;
  ad: string;
  abs: string;
  exh: string;
  dd: string;
  vwap: string;
  vwapSd1: string;
  vwapSd2: string;
}

export interface FootprintSeriesOptions extends CustomSeriesOptions {
  displayMode: FootprintMode;
  chartMode: ChartMode;
  footprintMinBarSpacing: number; // legacy; superseded by the zoom k-curve in _draw
  palette: FootprintPalette;
  fills: Fill[];
  settings: FootprintSettings;
  // normalized custom-indicator outputs (drawn by the renderer; never computed here)
  indicatorOutputs: IndicatorOutput[];
}

const DEFAULT_SETTINGS: FootprintSettings = {
  tickMultiplier: 1,
  imbalanceRatio: 3.0,
  imbalanceMinVolume: 50,
  showVwap: true,
  showSdBands: true,
  showPoc: true,
  showImbalances: true,
  showBadges: true,
  showFills: true,
  showThinCandle: true,
  lockBlockSize: false,
};

export const DARK_PALETTE: FootprintPalette = {
  buy: "#0e8a4f",
  buyHi: "#16c172",
  sell: "#b0263c",
  sellHi: "#ef4d63",
  neutral: "#3a4350",
  text: "#c7d0db",
  poc: "#f5d020",
  lpSup: "#22c55e",
  lpRes: "#ef4444",
  ad: "#14b8a6",
  abs: "#8b5cf6",
  exh: "#eab308",
  dd: "#ff7ac6",
  vwap: "#f59e0b",
  vwapSd1: "#d9a441",
  vwapSd2: "#9a6a1f",
};

export const LIGHT_PALETTE: FootprintPalette = {
  buy: "#16a34a",
  buyHi: "#15803d",
  sell: "#dc2626",
  sellHi: "#991b1b",
  neutral: "#adb5bd",
  text: "#212529",
  poc: "#ca8a04",
  lpSup: "#16a34a",
  lpRes: "#dc2626",
  ad: "#0d9488",
  abs: "#7c3aed",
  exh: "#ca8a04",
  dd: "#db2777",
  vwap: "#d97706",
  vwapSd1: "#b45309",
  vwapSd2: "#92400e",
};

// ---------- number formatting (mirrors the old renderer) ----------
function fmt(v: number): string {
  if (v >= 100000) return (v / 1000).toFixed(0) + "K";
  if (v >= 1000) return (v / 1000).toFixed(1) + "K";
  return String(Math.round(v));
}
function sfmt(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return sign + fmt(Math.abs(v));
}
// one consolidated price row (k base cells summed)
interface Bin {
  bid: number;
  ask: number;
  total: number;
  delta: number;
}
function binText(b: Bin, candleVolume: number, mode: FootprintMode): string {
  switch (mode) {
    case "delta":
      return `${b.delta > 0 ? "+" : ""}${fmt(b.delta)}`;
    case "volume":
      return fmt(b.total);
    case "volumePercent":
      return candleVolume > 0 ? `${((b.total / candleVolume) * 100).toFixed(0)}%` : "0%";
    case "bidAsk":
    default:
      return `${fmt(b.bid)} x ${fmt(b.ask)}`;
  }
}

// zoom -> consolidation multiplier (0 means "draw standard candles")
function consolidationK(barSpacing: number): number {
  if (barSpacing >= 110) return 1;
  if (barSpacing >= 80) return 2;
  if (barSpacing >= 50) return 4;
  if (barSpacing >= 25) return 10;
  return 0;
}

class FootprintSeriesRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, FootprintData> | null = null;
  private _options: FootprintSeriesOptions | null = null;

  update(data: PaneRendererCustomData<Time, FootprintData>, options: FootprintSeriesOptions): void {
    this._data = data;
    this._options = options;
  }

  draw(target: CanvasRenderingTarget2D, priceToCoordinate: PriceToCoordinateConverter): void {
    target.useMediaCoordinateSpace((scope) => this._draw(scope.context, priceToCoordinate));
  }

  private _draw(ctx: CanvasRenderingContext2D, priceToY: PriceToCoordinateConverter): void {
    const data = this._data;
    const opts = this._options;
    if (!data || !opts || data.visibleRange === null) return;
    const P = opts.palette;
    const bars = data.bars;
    const { from, to } = data.visibleRange;
    const visibleFrom = Math.max(0, Math.floor(from));
    const visibleTo = Math.min(bars.length, Math.ceil(to));
    const barSpacing = data.barSpacing;
    const S = opts.settings ?? DEFAULT_SETTINGS;
    // dynamic consolidation by zoom: k base rows per drawn row (0 -> candles)
    const k = consolidationK(barSpacing);
    const showFp = opts.chartMode === "footprint" && (S.lockBlockSize || k > 0);
    const colW = Math.max(4, barSpacing * 0.86);
    const bodyW = Math.max(1, barSpacing * 0.6);

    // VWAP / SD band polyline points, collected across the visible bars
    const vw: number[][] = [];
    const s1u: number[][] = [];
    const s1l: number[][] = [];
    const s2u: number[][] = [];
    const s2l: number[][] = [];

    ctx.save();

    // custom-indicator overlays: map candle.startTime(ms) -> x once, then draw
    // ZONES first (behind candles). Lines + shapes are drawn after the price
    // overlays below. Only price/custom/undefined-pane outputs land on this chart.
    const indOut = opts.indicatorOutputs;
    let xByTime: Map<number, number> | null = null;
    if (indOut && indOut.length) {
      xByTime = new Map<number, number>();
      for (let i = visibleFrom; i < visibleTo; i++) {
        const cc = bars[i]?.originalData?.candle;
        if (cc) xByTime.set(cc.startTime, bars[i].x);
      }
      this._drawIndicatorZones(ctx, indOut, xByTime, priceToY);
    }

    for (let i = visibleFrom; i < visibleTo; i++) {
      const bar = bars[i];
      const c = bar.originalData?.candle;
      if (!c) continue;
      const x = bar.x;
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      if (yHigh === null || yLow === null) continue;

      // collect overlay points (centre of column)
      const push = (price: number | null, arr: number[][]) => {
        if (price == null) return;
        const y = priceToY(price);
        if (y !== null) arr.push([x, y]);
      };
      push(c.vwap, vw);
      push(c.vwapSd1Upper, s1u);
      push(c.vwapSd1Lower, s1l);
      push(c.vwapSd2Upper, s2u);
      push(c.vwapSd2Lower, s2l);

      if (showFp) {
        this._drawCells(ctx, c, x, colW, priceToY, opts.displayMode, P, k, S);
        if (S.showThinCandle) this._drawThinCandle(ctx, c, x, colW, barSpacing, priceToY, P);
      } else {
        this._drawCandle(ctx, c, x, bodyW, yHigh, yLow, priceToY, P);
      }
      if (S.showBadges) this._drawBadges(ctx, c, x, yHigh, yLow, P);
    }

    // overlays last so they sit on top; each gated by its settings toggle
    if (S.showFills) this._drawFills(ctx, bars, visibleFrom, visibleTo, opts.fills, priceToY, P);
    if (S.showSdBands) {
      this._polyline(ctx, s2u, P.vwapSd2, 1, 0.45, true);
      this._polyline(ctx, s2l, P.vwapSd2, 1, 0.45, true);
      this._polyline(ctx, s1u, P.vwapSd1, 1, 0.55, true);
      this._polyline(ctx, s1l, P.vwapSd1, 1, 0.55, true);
    }
    if (S.showVwap) this._polyline(ctx, vw, P.vwap, 2, 0.85, false);

    // indicator lines + shapes sit on TOP of price overlays
    if (indOut && indOut.length && xByTime) {
      this._drawIndicatorLines(ctx, indOut, xByTime, priceToY);
      this._drawIndicatorShapes(ctx, indOut, xByTime, priceToY);
    }
    ctx.restore();
  }

  // ---- custom-indicator overlay drawing (operates only on normalized outputs) ----
  private _drawIndicatorZones(
    ctx: CanvasRenderingContext2D,
    outputs: IndicatorOutput[],
    xByTime: Map<number, number>,
    priceToY: PriceToCoordinateConverter,
  ): void {
    for (const o of outputs) {
      if (o.type !== "zone") continue;
      const x1 = xByTime.get(o.fromTime);
      const x2 = xByTime.get(o.toTime);
      const yTop = priceToY(o.high);
      const yBot = priceToY(o.low);
      if (x1 == null || x2 == null || yTop == null || yBot == null) continue;
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(yTop, yBot);
      ctx.save();
      ctx.globalAlpha = o.opacity ?? 0.15;
      ctx.fillStyle = o.color;
      ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, Math.abs(yBot - yTop)));
      ctx.restore();
    }
  }

  private _drawIndicatorLines(
    ctx: CanvasRenderingContext2D,
    outputs: IndicatorOutput[],
    xByTime: Map<number, number>,
    priceToY: PriceToCoordinateConverter,
  ): void {
    for (const o of outputs) {
      if (o.type !== "line") continue;
      // delta / cumDelta panes render on their own sub-charts, not the price pane
      if (o.pane === "delta" || o.pane === "cumDelta") continue;
      ctx.save();
      ctx.globalAlpha = o.opacity ?? 1;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width ?? 2;
      ctx.beginPath();
      let pen = false;
      for (const p of o.points) {
        const x = xByTime.get(p.time);
        if (x == null || !Number.isFinite(p.value)) {
          pen = false; // gap: don't connect across missing/off-chart points
          continue;
        }
        const y = priceToY(p.value);
        if (y == null) {
          pen = false;
          continue;
        }
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  private _drawIndicatorShapes(
    ctx: CanvasRenderingContext2D,
    outputs: IndicatorOutput[],
    xByTime: Map<number, number>,
    priceToY: PriceToCoordinateConverter,
  ): void {
    const s = 5;
    for (const o of outputs) {
      if (o.type !== "shape") continue;
      const x = xByTime.get(o.time);
      const y0 = priceToY(o.price);
      if (x == null || y0 == null) continue;
      const below = o.position === "below";
      const y = o.position === "above" ? y0 - 10 : below ? y0 + 10 : y0;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = o.color;
      ctx.beginPath();
      if (below) {
        ctx.moveTo(x - s, y + s);
        ctx.lineTo(x + s, y + s);
        ctx.lineTo(x, y - s); // points up
      } else {
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y - s);
        ctx.lineTo(x, y + s); // points down
      }
      ctx.closePath();
      ctx.fill();
      if (o.text) {
        ctx.font = "10px Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = below ? "top" : "bottom";
        ctx.fillText(o.text.slice(0, 16), x, below ? y + s + 2 : y - s - 2);
      }
      ctx.restore();
    }
  }

  private _drawCells(
    ctx: CanvasRenderingContext2D,
    c: FootprintCandle,
    x: number,
    colW: number,
    priceToY: PriceToCoordinateConverter,
    mode: FootprintMode,
    P: FootprintPalette,
    k: number,
    S: FootprintSettings,
  ): void {
    const rowSize = c.rowSize || 1;
    const kVal = S.lockBlockSize ? 1 : k;
    const kEff = Math.max(1, kVal * Math.max(1, S.tickMultiplier)); // base rows per drawn row

    // group base cells into consolidated bins keyed by absolute (floored) row index
    const bins = new Map<number, Bin>();
    for (const cell of c.cells) {
      const key = Math.floor(Math.round(cell.price / rowSize) / kEff);
      let b = bins.get(key);
      if (!b) {
        b = { bid: 0, ask: 0, total: 0, delta: 0 };
        bins.set(key, b);
      }
      b.bid += cell.bidVolume;
      b.ask += cell.askVolume;
      b.total += cell.total;
      b.delta += cell.delta;
    }

    // consolidated row height (kEff base rows tall); POC = highest-volume bin
    const yb0 = priceToY(c.low);
    const yb1 = priceToY(c.low + rowSize);
    const basePx = yb0 !== null && yb1 !== null ? Math.abs(yb1 - yb0) : 1;
    const rowPx = Math.max(1, basePx * kEff);
    const half = rowPx / 2;
    const rowH = Math.max(1, rowPx - 1);
    let maxTotal = 1;
    let pocKey: number | null = null;
    let pocMax = -1;
    for (const [key, b] of bins) {
      if (b.total > maxTotal) maxTotal = b.total;
      if (b.total > pocMax) {
        pocMax = b.total;
        pocKey = key;
      }
    }
    const left = x - colW / 2;

    for (const [key, b] of bins) {
      // bin centre = centre of the kEff base rows it spans
      const center = (key * kEff + (kEff - 1) / 2) * rowSize;
      const y = priceToY(center);
      if (y === null) continue;
      const top = y - half;

      const base = b.delta > 0 ? P.buy : b.delta < 0 ? P.sell : P.neutral;
      ctx.globalAlpha = 0.12 + 0.55 * (b.total / maxTotal);
      ctx.fillStyle = base;
      ctx.fillRect(left, top, colW, rowH);
      ctx.globalAlpha = 1;

      // client-side imbalance from the live ratio / min-volume settings
      const buyImb = S.showImbalances && b.ask >= S.imbalanceRatio * Math.max(b.bid, 1) && b.total >= S.imbalanceMinVolume;
      const sellImb = S.showImbalances && b.bid >= S.imbalanceRatio * Math.max(b.ask, 1) && b.total >= S.imbalanceMinVolume;
      if (buyImb || sellImb) {
        ctx.strokeStyle = buyImb ? P.buyHi : P.sellHi;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left, top, colW, rowH);
      }
      if (S.showPoc && key === pocKey) {
        ctx.strokeStyle = P.poc;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left - 1, top, colW + 2, rowH);
      }
      if (rowPx >= 11) {
        ctx.fillStyle = buyImb ? P.buyHi : sellImb ? P.sellHi : P.text;
        ctx.font = `${Math.min(11, rowPx - 2)}px Consolas, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(binText(b, c.totalVolume, mode), x, y);
      }
    }
  }

  // GoCharting-style thin candlestick drawn just to the LEFT of the footprint cells
  private _drawThinCandle(
    ctx: CanvasRenderingContext2D,
    c: FootprintCandle,
    x: number,
    colW: number,
    barSpacing: number,
    priceToY: PriceToCoordinateConverter,
    P: FootprintPalette,
  ): void {
    const yHigh = priceToY(c.high);
    const yLow = priceToY(c.low);
    const yOpen = priceToY(c.open);
    const yClose = priceToY(c.close);
    if (yHigh === null || yLow === null || yOpen === null || yClose === null) return;
    const col = c.close >= c.open ? P.buyHi : P.sellHi;
    const candleW = 3;
    // cells span [x - colW/2, x + colW/2]; sit 4px to their left, but clamp so the
    // body never bleeds into the previous bar's cells at the tightest footprint zoom
    const candleX = Math.max(x - colW / 2 - 4, x - barSpacing + colW / 2 + candleW / 2);
    ctx.save();
    // wick (1px high -> low)
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(candleX, yHigh);
    ctx.lineTo(candleX, yLow);
    ctx.stroke();
    // body (open -> close)
    const top = Math.min(yOpen, yClose);
    const height = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillStyle = col;
    ctx.fillRect(candleX - candleW / 2, top, candleW, height);
    ctx.restore();
  }

  private _drawCandle(
    ctx: CanvasRenderingContext2D,
    c: FootprintCandle,
    x: number,
    bodyW: number,
    yHigh: number,
    yLow: number,
    priceToY: PriceToCoordinateConverter,
    P: FootprintPalette,
  ): void {
    const bull = c.close >= c.open;
    const col = bull ? P.buyHi : P.sellHi;
    // wick
    ctx.fillStyle = col;
    ctx.fillRect(x - 0.75, Math.min(yHigh, yLow), 1.5, Math.max(1, Math.abs(yLow - yHigh)));
    // body
    const yO = priceToY(c.open);
    const yC = priceToY(c.close);
    if (yO === null || yC === null) return;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
  }

  private _badge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
    const w = text.length * 7 + 8;
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y - 8, w, 16);
    ctx.fillStyle = "#06120c";
    ctx.font = "10px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  private _drawBadges(
    ctx: CanvasRenderingContext2D,
    c: FootprintCandle,
    x: number,
    yHigh: number,
    yLow: number,
    P: FootprintPalette,
  ): void {
    const s = c.signals;
    if (s.lp) this._badge(ctx, x, yHigh - 12, "LP", s.lpSide === "support" ? P.lpSup : P.lpRes);
    if (s.ad) this._badge(ctx, x, yLow + 12, "AD", P.ad);
    if (s.absorption) this._badge(ctx, x, (yHigh + yLow) / 2, "A", P.abs);
    if (s.exhaustion) this._badge(ctx, x, s.exhaustionType === "high" ? yHigh - 26 : yLow + 26, "E", P.exh);
    if (s.deltaDivergence) this._badge(ctx, x, s.deltaDivergenceSide === "bullish" ? yLow + 40 : yHigh - 40, "DD", P.dd);
  }

  private _drawFills(
    ctx: CanvasRenderingContext2D,
    bars: readonly { x: number; originalData?: FootprintData }[],
    from: number,
    to: number,
    fills: Fill[],
    priceToY: PriceToCoordinateConverter,
    P: FootprintPalette,
  ): void {
    if (!fills.length) return;
    for (let i = from; i < to; i++) {
      const c = bars[i].originalData?.candle;
      if (!c) continue;
      const x = bars[i].x;
      for (const f of fills) {
        if (f.symbol !== c.symbol || f.timestamp < c.startTime || f.timestamp >= c.endTime) continue;
        const y = priceToY(f.price);
        if (y === null) continue;
        const buy = f.side === "buy";
        const col = buy ? P.buyHi : P.sellHi;
        const s = 6;
        ctx.fillStyle = col;
        ctx.beginPath();
        if (buy) {
          ctx.moveTo(x - s, y + s - 1);
          ctx.lineTo(x + s, y + s - 1);
          ctx.lineTo(x, y - s + 1);
        } else {
          ctx.moveTo(x - s, y - s + 1);
          ctx.lineTo(x + s, y - s + 1);
          ctx.lineTo(x, y + s - 1);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private _polyline(
    ctx: CanvasRenderingContext2D,
    pts: number[][],
    color: string,
    width: number,
    alpha: number,
    dashed: boolean,
  ): void {
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }
}

export class FootprintSeriesView
  implements ICustomSeriesPaneView<Time, FootprintData, FootprintSeriesOptions>
{
  private _renderer = new FootprintSeriesRenderer();

  renderer(): FootprintSeriesRenderer {
    return this._renderer;
  }

  update(data: PaneRendererCustomData<Time, FootprintData>, options: FootprintSeriesOptions): void {
    this._renderer.update(data, options);
  }

  // autoscale + crosshair use [low, high, close]; last value (close) is "current"
  priceValueBuilder(d: FootprintData): CustomSeriesPricePlotValues {
    const c = d.candle;
    return [c.low, c.high, c.close];
  }

  isWhitespace(d: FootprintData | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> {
    return !(d as Partial<FootprintData>).candle;
  }

  defaultOptions(): FootprintSeriesOptions {
    return {
      ...customSeriesDefaultOptions,
      displayMode: "bidAsk",
      chartMode: "footprint",
      footprintMinBarSpacing: 85,
      palette: DARK_PALETTE,
      fills: [],
      settings: DEFAULT_SETTINGS,
      indicatorOutputs: [],
    };
  }
}

// concrete series-api type so callers' applyOptions() accept the custom fields
export type FootprintSeriesApi = ISeriesApi<
  "Custom",
  Time,
  FootprintData | WhitespaceData<Time>,
  FootprintSeriesOptions,
  SeriesPartialOptions<FootprintSeriesOptions>
>;
