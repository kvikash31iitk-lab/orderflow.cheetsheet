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
import type {
  Fill,
  FootprintCandle,
  FootprintMode,
  FootprintSettings,
  FootprintTextFormat,
} from "../types/orderflow";
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

// Fallback only — the real settings always arrive via opts.settings (store source of truth).
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
  showLastValue: true,
  showSeriesName: false,
  showCluster: true,
  clusterColumns: "single",
  colorMatrix: "default",
  autoFontSize: true,
  fixedFontSize: 10,
  textDensity: "auto",
  showProfile: false,
  leftFormat: "sellVolume",
  rightFormat: "buyVolume",
  leftTextColor: "",
  rightTextColor: "",
  leftBackground: false,
  rightBackground: false,
  leftFill: "",
  rightFill: "",
  imbalanceBuyColor: "",
  imbalanceSellColor: "",
  pocColor: "",
  showPocMarker: false,
  pocMarkerColor: "",
  extendPoc: false,
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

// the single-column toolbar mode maps to a cluster text format
const MODE_TO_FORMAT: Record<FootprintMode, FootprintTextFormat> = {
  bidAsk: "bidAsk",
  delta: "delta",
  volume: "volume",
  volumePercent: "volumePct",
};

function pct(part: number, whole: number, signed = false): string {
  if (whole <= 0) return "0%";
  const v = (part / whole) * 100;
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(0)}%`;
}

// Text for one consolidated bin in the requested format. `bid` = aggressive sell volume,
// `ask` = aggressive buy volume. Trade-count formats return "" — their UI options are
// disabled because cells carry volumes, not per-cell trade counts (never faked).
function fmtFormat(format: FootprintTextFormat, b: Bin, candleVolume: number): string {
  switch (format) {
    case "volume": return fmt(b.total);
    case "buyVolume": return fmt(b.ask);
    case "sellVolume": return fmt(b.bid);
    case "buyVolumePct": return pct(b.ask, b.total);
    case "sellVolumePct": return pct(b.bid, b.total);
    case "delta": return sfmt(b.delta);
    case "deltaPct": return pct(b.delta, b.total, true);
    case "volumePct": return pct(b.total, candleVolume);
    case "bidAsk": return `${fmt(b.bid)} x ${fmt(b.ask)}`;
    case "bidAskPlain": return `${fmt(b.bid)} ${fmt(b.ask)}`;
    default: return ""; // trade-count formats are unsupported -> hidden
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

// ---------- adaptive in-cell text (GoCharting-style: scale to fit, else hide) ----------
const CELL_FONT_STACK = "Consolas, monospace";
const CELL_PAD_X = 2; // px of horizontal breathing room inside each cell
const MIN_CELL_FONT = 7; // below this the text is illegible -> hide it entirely
const MAX_CELL_FONT = 13; // never grow past this however tall the cell is
const MIN_CELL_TEXT_W = 12; // a column narrower than this can't hold even "13" -> hide

// measureText() is cached by `${fontPx} ${text}`: the renderer repaints every frame
// while zooming, but the set of (font,string) pairs per frame is small and repeats heavily.
// The cache is bounded (cleared past a cap) so it can never leak across a long session.
const _measureCache = new Map<string, number>();
function measuredWidth(ctx: CanvasRenderingContext2D, fontPx: number, text: string): number {
  const key = `${fontPx} ${text}`;
  const hit = _measureCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = `${fontPx}px ${CELL_FONT_STACK}`;
  const w = ctx.measureText(text).width;
  if (_measureCache.size > 4096) _measureCache.clear();
  _measureCache.set(key, w);
  return w;
}

// ONE uniform text-layout decision for the whole footprint view (GoCharting-style): a single
// font size + a single full/compact/hidden mode, never a per-cell shrink. Sized so the WIDEST
// possible string in the view still fits the (constant) column width.
interface TextLayout {
  mode: "hidden" | "full" | "compact";
  fontPx: number;
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
    // "Show Cluster" off -> footprint zoom still draws plain candles (no number grid)
    const showClusters = showFp && S.showCluster !== false;
    const colW = Math.max(4, barSpacing * 0.86);
    const bodyW = Math.max(1, barSpacing * 0.6);

    // ONE text-layout decision for the whole footprint view -> uniform font everywhere
    const textLayout: TextLayout = showClusters
      ? this._computeTextLayout(ctx, bars, visibleFrom, visibleTo, colW, priceToY, opts.displayMode, k, S)
      : { mode: "hidden", fontPx: 0 };

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

      if (showClusters) {
        this._drawCells(ctx, c, x, colW, barSpacing, priceToY, opts.displayMode, P, k, S, textLayout);
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
    barSpacing: number,
    priceToY: PriceToCoordinateConverter,
    mode: FootprintMode,
    P: FootprintPalette,
    k: number,
    S: FootprintSettings,
    layout: TextLayout,
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

    // consolidated row height (kEff base rows tall)
    const yb0 = priceToY(c.low);
    const yb1 = priceToY(c.low + rowSize);
    const basePx = yb0 !== null && yb1 !== null ? Math.abs(yb1 - yb0) : 1;
    const rowPx = Math.max(1, basePx * kEff);
    const half = rowPx / 2;
    const rowH = Math.max(1, rowPx - 1);

    // per-candle maxima for the colour-matrix intensity + the POC bin
    let maxTotal = 1;
    let maxAbsDelta = 1;
    let pocKey: number | null = null;
    let pocMax = -1;
    for (const [key, b] of bins) {
      if (b.total > maxTotal) maxTotal = b.total;
      const ad = Math.abs(b.delta);
      if (ad > maxAbsDelta) maxAbsDelta = ad;
      if (b.total > pocMax) {
        pocMax = b.total;
        pocKey = key;
      }
    }

    const left = x - colW / 2;
    const matrix = S.colorMatrix ?? "default";
    const double = (S.clusterColumns ?? "single") === "double";
    const imbBuyCol = S.imbalanceBuyColor || P.buyHi;
    const imbSellCol = S.imbalanceSellColor || P.sellHi;
    const pocCol = S.pocColor || P.poc;
    const singleFormat = MODE_TO_FORMAT[mode];
    // text uses ONE uniform font + mode for the whole view (decided in _computeTextLayout)
    const showText = layout.mode !== "hidden";

    let pocTop = 0; // remembered for the POC marker / extend line (drawn once, after cells)
    let pocSeen = false;

    for (const [key, b] of bins) {
      // bin centre = centre of the kEff base rows it spans
      const center = (key * kEff + (kEff - 1) / 2) * rowSize;
      const y = priceToY(center);
      if (y === null) continue;
      const top = y - half;

      // ---- cell fill: colour matrix (Default = delta hue / volume intensity;
      //      Volume = neutral hue / volume intensity; Delta = delta hue / |delta| intensity)
      let hue: string;
      let intensity: number;
      if (matrix === "volume") {
        hue = P.neutral;
        intensity = b.total / maxTotal;
      } else if (matrix === "delta") {
        hue = b.delta > 0 ? P.buy : b.delta < 0 ? P.sell : P.neutral;
        intensity = Math.abs(b.delta) / maxAbsDelta;
      } else {
        hue = b.delta > 0 ? P.buy : b.delta < 0 ? P.sell : P.neutral;
        intensity = b.total / maxTotal;
      }
      ctx.globalAlpha = 0.12 + 0.55 * Math.max(0, Math.min(1, intensity));
      ctx.fillStyle = hue;
      ctx.fillRect(left, top, colW, rowH);
      ctx.globalAlpha = 1;

      // ---- optional per-cluster background tint (clipped to the side, subtle) ----
      if (S.leftBackground) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = S.leftFill || P.neutral;
        ctx.fillRect(left, top, double ? colW / 2 : colW, rowH);
        ctx.globalAlpha = 1;
      }
      if (double && S.rightBackground) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = S.rightFill || P.neutral;
        ctx.fillRect(left + colW / 2, top, colW / 2, rowH);
        ctx.globalAlpha = 1;
      }

      // ---- optional volume-profile bar along the cell bottom (width ∝ volume) ----
      if (S.showProfile) {
        const ph = Math.min(3, rowH * 0.3);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = hue;
        ctx.fillRect(left, top + rowH - ph, colW * Math.max(0, Math.min(1, b.total / maxTotal)), ph);
        ctx.globalAlpha = 1;
      }

      // ---- imbalance outline (client-side from the live ratio / min-volume settings) ----
      const buyImb = S.showImbalances && b.ask >= S.imbalanceRatio * Math.max(b.bid, 1) && b.total >= S.imbalanceMinVolume;
      const sellImb = S.showImbalances && b.bid >= S.imbalanceRatio * Math.max(b.ask, 1) && b.total >= S.imbalanceMinVolume;
      if (buyImb || sellImb) {
        ctx.strokeStyle = buyImb ? imbBuyCol : imbSellCol;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left, top, colW, rowH);
      }

      // ---- POC outline (highest-volume bin) ----
      const isPoc = key === pocKey;
      if (S.showPoc && isPoc) {
        ctx.strokeStyle = pocCol;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left - 1, top, colW + 2, rowH);
      }
      if (isPoc) {
        pocTop = top;
        pocSeen = true;
      }

      // ---- uniform text: ONE font + mode for the whole view; hard clip guards overflow ----
      if (showText) {
        const fp = layout.fontPx;
        if (double) {
          const lTxt = fmtFormat(S.leftFormat, b, c.totalVolume);
          const rTxt = fmtFormat(S.rightFormat, b, c.totalVolume);
          const lCol = buyImb ? imbBuyCol : sellImb ? imbSellCol : S.leftTextColor || P.text;
          const rCol = buyImb ? imbBuyCol : sellImb ? imbSellCol : S.rightTextColor || P.text;
          if (lTxt) this._drawClipped(ctx, lTxt, left + colW / 4, y, left, top, colW / 2, rowH, fp, lCol);
          if (rTxt) this._drawClipped(ctx, rTxt, left + (3 * colW) / 4, y, left + colW / 2, top, colW / 2, rowH, fp, rCol);
        } else {
          let txt = fmtFormat(singleFormat, b, c.totalVolume);
          if (txt) {
            if (layout.mode === "compact" && singleFormat === "bidAsk") txt = `${fmt(b.bid)}×${fmt(b.ask)}`;
            const col = buyImb ? imbBuyCol : sellImb ? imbSellCol : S.leftTextColor || P.text;
            this._drawClipped(ctx, txt, x, y, left, top, colW, rowH, fp, col);
          }
        }
      }
    }

    // ---- POC marker + extend line (once per candle) ----
    if (pocSeen) {
      const pocY = pocTop + rowH / 2;
      if (S.showPocMarker) {
        const s = Math.min(4, Math.max(3, rowH / 2));
        ctx.fillStyle = S.pocMarkerColor || pocCol;
        ctx.beginPath(); // small triangle inside the cell's left edge, pointing right
        ctx.moveTo(left + 1, pocY - s);
        ctx.lineTo(left + 1, pocY + s);
        ctx.lineTo(left + 1 + s, pocY);
        ctx.closePath();
        ctx.fill();
      }
      if (S.extendPoc) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = pocCol;
        ctx.lineWidth = 1;
        ctx.beginPath(); // extend the POC level to the right toward the next candle
        ctx.moveTo(left + colW, pocY);
        ctx.lineTo(left + colW + Math.max(8, barSpacing), pocY);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Decide ONE font + full/compact/hidden mode for the entire visible footprint, sized so the
  // widest possible string fits the (constant) column width. rowH + colW are global-constant
  // for a draw pass (linear price scale, shared rowSize/kEff), so the result is uniform
  // everywhere — no per-cell shrink, which is what made neighbouring cells differ in size.
  private _computeTextLayout(
    ctx: CanvasRenderingContext2D,
    bars: readonly { x: number; originalData?: FootprintData }[],
    from: number,
    to: number,
    colW: number,
    priceToY: PriceToCoordinateConverter,
    mode: FootprintMode,
    k: number,
    S: FootprintSettings,
  ): TextLayout {
    const hidden: TextLayout = { mode: "hidden", fontPx: 0 };
    const double = (S.clusterColumns ?? "single") === "double";
    const availW = (double ? colW / 2 : colW) - 2 * CELL_PAD_X;
    const kEff = Math.max(1, (S.lockBlockSize ? 1 : k) * Math.max(1, S.tickMultiplier));

    // reference candle: rowSize + one base-row's pixel height (linear scale -> same for all)
    let rowSize = 1;
    let refLow: number | null = null;
    for (let i = from; i < to; i++) {
      const c = bars[i]?.originalData?.candle;
      if (c) {
        rowSize = c.rowSize || 1;
        refLow = c.low;
        break;
      }
    }
    if (refLow == null) return hidden;
    const yA = priceToY(refLow);
    const yB = priceToY(refLow + rowSize);
    const basePx = yA !== null && yB !== null ? Math.abs(yB - yA) : 1;
    const rowH = Math.max(1, Math.max(1, basePx * kEff) - 1);
    if (availW < MIN_CELL_TEXT_W || rowH < MIN_CELL_FONT + 1) return hidden;

    // scan every visible bin and remember the ACTUAL widest string the draw pass will paint
    // (monospace -> longest string = widest). This mirrors _drawCells exactly, so the chosen
    // font is guaranteed to fit every real cell — without relying on fmt() being width-monotonic
    // (it is NOT: fmt(99999)="100.0K" is wider than fmt(150000)="150K").
    const single = MODE_TO_FORMAT[mode];
    let longestFull = "";
    let longestCompact = "";
    const consider = (full: string, compact: string) => {
      if (full.length > longestFull.length) longestFull = full;
      if (compact.length > longestCompact.length) longestCompact = compact;
    };
    const bins = new Map<number, Bin>();
    for (let i = from; i < to; i++) {
      const c = bars[i]?.originalData?.candle;
      if (!c) continue;
      bins.clear();
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
      for (const b of bins.values()) {
        if (double) {
          const l = fmtFormat(S.leftFormat, b, c.totalVolume);
          const r = fmtFormat(S.rightFormat, b, c.totalVolume);
          if (l) consider(l, l);
          if (r) consider(r, r);
        } else {
          const full = fmtFormat(single, b, c.totalVolume);
          if (full) consider(full, single === "bidAsk" ? `${fmt(b.bid)}×${fmt(b.ask)}` : full);
        }
      }
    }
    if (!longestFull) return hidden; // unsupported (trade-count) format, or nothing to draw

    const fontH =
      S.autoFontSize === false
        ? Math.max(MIN_CELL_FONT, Math.min(Math.round(S.fixedFontSize || 10), MAX_CELL_FONT, Math.floor(rowH - 1)))
        : Math.min(MAX_CELL_FONT, Math.floor(rowH - 2));
    if (fontH < MIN_CELL_FONT) return hidden;

    // density lever (all branches still yield ONE uniform font + mode for the whole view):
    //  full    = only ever show full labels; hide if they don't fit (no compact fallback)
    //  compact = always use the compact form, then one uniform shrink, then hide
    //  auto    = full when it fits, else compact, else one uniform shrink, else hide (default)
    const density = S.textDensity ?? "auto";
    if (density === "full") {
      return measuredWidth(ctx, fontH, longestFull) <= availW ? { mode: "full", fontPx: fontH } : hidden;
    }
    if (density === "compact") {
      const cwC = measuredWidth(ctx, fontH, longestCompact);
      if (cwC <= availW) return { mode: "compact", fontPx: fontH };
      const shrunkC = Math.floor(fontH * (availW / cwC));
      return shrunkC >= MIN_CELL_FONT ? { mode: "compact", fontPx: shrunkC } : hidden;
    }
    if (measuredWidth(ctx, fontH, longestFull) <= availW) return { mode: "full", fontPx: fontH };
    const cw = measuredWidth(ctx, fontH, longestCompact);
    if (cw <= availW) return { mode: "compact", fontPx: fontH };
    const shrunk = Math.floor(fontH * (availW / cw)); // ONE uniform shrink, never per-cell
    if (shrunk >= MIN_CELL_FONT) return { mode: "compact", fontPx: shrunk };
    return hidden;
  }

  // Draw `text` centred in the cell at a FIXED font (no per-cell measure/shrink — the global
  // layout already guarantees fit). A hard clip to the cell rect is the overflow backstop.
  private _drawClipped(
    ctx: CanvasRenderingContext2D,
    text: string,
    cx: number,
    cy: number,
    cellLeft: number,
    cellTop: number,
    cellW: number,
    cellH: number,
    fontPx: number,
    color: string,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cellLeft, cellTop, cellW, cellH);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.font = `${fontPx}px ${CELL_FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy);
    ctx.restore();
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
