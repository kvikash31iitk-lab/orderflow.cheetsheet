// Drawing layer as a lightweight-charts v4 series primitive.
//
// One primitive is attached to the footprint custom series; it paints ALL drawing
// objects (committed + the in-progress draft) on top of the price pane. It mirrors
// the footprint custom-series renderer pattern: paint inside
// target.useMediaCoordinateSpace(scope => ...). Unlike a custom-series renderer, an
// ISeriesPrimitive pane renderer.draw receives ONLY `target`, so we capture the
// chart + series in attached() and do coordinate conversion ourselves
// (timeScale().timeToCoordinate for x — chart time is SECONDS; series.priceToCoordinate
// for y). The chart repaints this automatically on pan/zoom/data; we call requestUpdate()
// for state that changes without a chart repaint (drag preview, selection, add/remove).
import type {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { DrawingObject } from "./types";
import { FIB_LEVELS_FULL } from "./types";
import { drawingHandles, type Px } from "./geometry";

// minimal candle shape the Measure tool needs (bars count + volume between two anchor times)
export interface CandleLite {
  startTime: number;
  totalVolume?: number;
}

type ChartApi = SeriesAttachedParameter<Time>["chart"];
type SeriesApi = SeriesAttachedParameter<Time>["series"];

// a selected Anchored VWAP highlighted on the chart: its plotted line points (data
// coords) so the primitive can stroke a halo + anchor handle on top of it.
export interface AvwapSelection {
  points: { time: number; value: number }[];
  color: string;
}

export interface DrawingRenderState {
  drawings: DrawingObject[]; // already filtered to current symbol + visible, draft merged in
  selectedId: string | null;
  theme: "dark" | "light";
  candles?: CandleLite[]; // current symbol's candles (Measure tool stats)
  avwapSelection?: AvwapSelection | null;
}

// ---- formatting helpers (Measure tool) ----
function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}
function fmtElapsed(ms: number): string {
  const m = Math.abs(ms);
  const days = Math.floor(m / 86_400_000);
  const hours = Math.floor((m % 86_400_000) / 3_600_000);
  const mins = Math.floor((m % 3_600_000) / 60_000);
  if (days >= 1) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours >= 1) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}
function fmtRatio(r: number): string {
  return Number(r.toFixed(3)).toString();
}
// bars + summed volume for candles whose startTime is within [t0,t1] (inclusive)
function measureRange(candles: CandleLite[], t0: number, t1: number): { bars: number; volume: number } {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  let bars = 0;
  let volume = 0;
  for (const c of candles) {
    if (c.startTime >= lo && c.startTime <= hi) {
      bars += 1;
      volume += c.totalVolume ?? 0;
    }
  }
  return { bars, volume };
}

function dashFor(style: DrawingObject["style"]): number[] {
  if (style.lineStyle === "dashed") return [6, 4];
  if (style.lineStyle === "dotted") return [2, 3];
  return [];
}

function withAlpha(hex: string, alpha: number): string {
  // #rrggbb -> rgba(); pass through anything already rgba/named
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class DrawingRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private _provider: () => DrawingRenderState,
    private _apiGetter: () => { chart: ChartApi; series: SeriesApi } | null,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const api = this._apiGetter();
    if (!api) return;
    const state = this._provider();
    if (!state.drawings.length && !state.avwapSelection) return;
    target.useMediaCoordinateSpace((scope) => {
      this._draw(scope.context, scope.mediaSize, api.chart, api.series, state);
    });
  }

  private _draw(
    ctx: CanvasRenderingContext2D,
    size: { width: number; height: number },
    chart: ChartApi,
    series: SeriesApi,
    state: DrawingRenderState,
  ): void {
    const ts = chart.timeScale();
    const toX = (timeMs: number): number | null => {
      const c = ts.timeToCoordinate(Math.floor(timeMs / 1000) as UTCTimestamp);
      return c == null ? null : (c as number);
    };
    const toY = (price: number): number | null => {
      const c = series.priceToCoordinate(price);
      return c == null ? null : (c as number);
    };
    const toPx = (pt: { time: number; price: number }): Px | null => {
      const x = toX(pt.time);
      const y = toY(pt.price);
      return x == null || y == null ? null : { x, y };
    };

    for (const d of state.drawings) {
      ctx.save();
      ctx.strokeStyle = d.style.color;
      ctx.fillStyle = d.style.color;
      ctx.lineWidth = d.style.width;
      ctx.setLineDash(dashFor(d.style));
      this._drawOne(ctx, size, d, toX, toY, state);
      ctx.restore();
    }

    // a selected Anchored VWAP: halo over its line + an anchor handle at point[0]
    if (state.avwapSelection) this._drawAvwapSelection(ctx, state.avwapSelection, toPx, state.theme);

    // selection handles painted last, on top
    const sel = state.drawings.find((d) => d.id === state.selectedId);
    if (sel) this._drawHandles(ctx, sel, toPx, state.theme);
  }

  private _drawAvwapSelection(
    ctx: CanvasRenderingContext2D,
    sel: AvwapSelection,
    toPx: (pt: { time: number; price: number }) => Px | null,
    theme: "dark" | "light",
  ): void {
    const pts = sel.points
      .map((p) => toPx({ time: p.time, price: p.value }))
      .filter((p): p is Px => p != null);
    if (!pts.length) return;
    ctx.save();
    ctx.setLineDash([]);
    // translucent halo tracing the AVWAP line so the selection reads on the chart
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = withAlpha(sel.color, 0.35);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    // square anchor handle at the first plotted point
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme === "light" ? "#212529" : "#ffffff";
    ctx.fillStyle = sel.color;
    const a = pts[0];
    ctx.beginPath();
    ctx.rect(a.x - 4, a.y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private _drawOne(
    ctx: CanvasRenderingContext2D,
    size: { width: number; height: number },
    d: DrawingObject,
    toX: (t: number) => number | null,
    toY: (p: number) => number | null,
    state: DrawingRenderState,
  ): void {
    const p = d.points ?? [];
    switch (d.type) {
      case "horizontal-line": {
        const y = p[0] ? toY(p[0].price) : null;
        if (y == null) return;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
        ctx.stroke();
        this._priceTag(ctx, size.width, y, p[0]!.price, d.style.color);
        return;
      }
      case "vertical-line": {
        const x = p[0] ? toX(p[0].time) : null;
        if (x == null) return;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
        ctx.stroke();
        return;
      }
      case "trendline": {
        const a = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const b = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (a == null || ay == null || b == null || by == null) return;
        ctx.beginPath();
        ctx.moveTo(a, ay);
        ctx.lineTo(b, by);
        ctx.stroke();
        return;
      }
      case "ray": {
        const a = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const b = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (a == null || ay == null || b == null || by == null) return;
        const dx = b - a;
        const dy = by - ay;
        const norm = Math.hypot(dx, dy) || 1;
        const far = size.width + size.height;
        ctx.beginPath();
        ctx.moveTo(a, ay);
        ctx.lineTo(b + (dx / norm) * far, by + (dy / norm) * far);
        ctx.stroke();
        return;
      }
      case "rectangle": {
        const a = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const b = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (a == null || ay == null || b == null || by == null) return;
        const x = Math.min(a, b);
        const y = Math.min(ay, by);
        const w = Math.abs(b - a);
        const h = Math.abs(by - ay);
        ctx.fillStyle = withAlpha(d.style.fillColor ?? d.style.color, d.style.fillOpacity ?? 0.12);
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = d.style.color;
        ctx.strokeRect(x, y, w, h);
        return;
      }
      case "fib-retracement": {
        const ax = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const bx = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (ax == null || ay == null || bx == null || by == null) return;
        const x0 = Math.min(ax, bx);
        const x1 = Math.max(ax, bx);
        const price0 = p[0]!.price;
        const price1 = p[1]!.price;
        const yOf = (r: number) => ay + (by - ay) * r;
        const priceOf = (r: number) => price0 + (price1 - price0) * r;
        const fillOp = d.style.fillOpacity ?? 0.07;

        // 1) diagonal baseline A -> B (subtle, dashed) so the swing is visible
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(d.style.color, 0.5);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();

        // 2) tinted bands between consecutive levels (low opacity -> reads on light + dark)
        for (let i = 0; i < FIB_LEVELS_FULL.length - 1; i++) {
          const yA = yOf(FIB_LEVELS_FULL[i].ratio);
          const yB = yOf(FIB_LEVELS_FULL[i + 1].ratio);
          ctx.fillStyle = withAlpha(FIB_LEVELS_FULL[i + 1].color, fillOp);
          ctx.fillRect(x0, Math.min(yA, yB), x1 - x0, Math.abs(yB - yA));
        }

        // 3) level lines + "ratio (price)" labels at the left edge (away from the price scale)
        ctx.setLineDash([]);
        ctx.lineWidth = d.style.width;
        ctx.font = "10px Consolas, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const lx = Math.max(2, x0) + 4;
        for (const lvl of FIB_LEVELS_FULL) {
          const y = yOf(lvl.ratio);
          ctx.strokeStyle = lvl.color;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          const label = `${fmtRatio(lvl.ratio)} (${priceOf(lvl.ratio).toFixed(2)})`;
          const w = ctx.measureText(label).width + 6;
          ctx.fillStyle = state.theme === "light" ? "rgba(255,255,255,0.78)" : "rgba(10,14,18,0.6)";
          ctx.fillRect(lx - 3, y - 7, w, 14);
          ctx.fillStyle = lvl.color;
          ctx.fillText(label, lx, y);
        }
        return;
      }
      case "measure": {
        const ax = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const bx = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (ax == null || ay == null || bx == null || by == null) return;
        const pA = p[0]!.price;
        const pB = p[1]!.price;
        const up = pB >= pA;
        const accent = up ? "#16c172" : "#ef4d63"; // green up / red down
        const x = Math.min(ax, bx);
        const y = Math.min(ay, by);
        const w = Math.abs(bx - ax);
        const h = Math.abs(by - ay);

        // translucent direction-coloured box + dashed border
        ctx.save();
        ctx.fillStyle = withAlpha(accent, 0.14);
        ctx.fillRect(x, y, w, h);
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(accent, 0.9);
        ctx.strokeRect(x, y, w, h);
        // arrow A -> B through the box
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        const ang = Math.atan2(by - ay, bx - ax);
        const ah = 7;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - ah * Math.cos(ang - Math.PI / 6), by - ah * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - ah * Math.cos(ang + Math.PI / 6), by - ah * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
        ctx.restore();

        // stats label
        const dp = pB - pA;
        const pct = pA !== 0 ? (dp / pA) * 100 : 0;
        const sign = dp >= 0 ? "+" : "";
        const showVol = (d.meta?.showVolume ?? true) !== false;
        const { bars, volume } = measureRange(state.candles ?? [], p[0]!.time, p[1]!.time);
        const lines = [
          `${sign}${dp.toFixed(2)} (${sign}${pct.toFixed(2)}%)`,
          `${bars} bars, ${fmtElapsed(p[1]!.time - p[0]!.time)}`,
        ];
        if (showVol && volume > 0) lines.push(`Vol ${fmtVol(volume)}`);
        const cx = x + w / 2;
        const labelY = up ? y - 6 : y + h + 6;
        this._drawStatsLabel(ctx, cx, labelY, up ? "above" : "below", lines, accent, state.theme);
        return;
      }
      case "brush": {
        const path = d.path ?? [];
        ctx.beginPath();
        let pen = false;
        for (const pt of path) {
          const x = toX(pt.time);
          const y = toY(pt.price);
          if (x == null || y == null) {
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
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        return;
      }
      case "text": {
        const x = p[0] ? toX(p[0].time) : null;
        const y = p[0] ? toY(p[0].price) : null;
        if (x == null || y == null) return;
        const fs = d.style.fontSize ?? 12;
        const txt = d.text ?? "Text";
        ctx.font = `${fs}px Outfit, system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.setLineDash([]);
        ctx.fillStyle = d.style.color;
        ctx.fillText(txt, x, y);
        return;
      }
    }
  }

  private _priceTag(ctx: CanvasRenderingContext2D, width: number, y: number, price: number, color: string): void {
    const label = price.toFixed(2);
    ctx.save();
    ctx.font = "10px Consolas, monospace";
    ctx.setLineDash([]);
    const w = label.length * 6 + 8;
    ctx.fillStyle = color;
    ctx.fillRect(width - w - 2, y - 8, w, 16);
    ctx.fillStyle = "#06120c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, width - w / 2 - 2, y);
    ctx.restore();
  }

  private _roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Compact multi-line stats card (Measure tool), centred horizontally at cx and anchored
  // above/below the box. First line uses the direction accent; the rest are muted.
  private _drawStatsLabel(
    ctx: CanvasRenderingContext2D,
    cx: number,
    anchorY: number,
    anchor: "above" | "below",
    lines: string[],
    accent: string,
    theme: "dark" | "light",
  ): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = "10px Outfit, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const lh = 13;
    const padX = 7;
    const padY = 5;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
    const h = lines.length * lh + padY * 2;
    const bx = cx - w / 2;
    const by = anchor === "above" ? anchorY - h : anchorY;
    ctx.fillStyle = theme === "light" ? "rgba(255,255,255,0.96)" : "rgba(18,22,28,0.95)";
    this._roundRect(ctx, bx, by, w, h, 4);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(accent, 0.9);
    this._roundRect(ctx, bx, by, w, h, 4);
    ctx.stroke();
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? accent : theme === "light" ? "#495057" : "#9aa7b4";
      ctx.fillText(l, cx, by + padY + lh / 2 + i * lh);
    });
    ctx.restore();
  }

  private _drawHandles(
    ctx: CanvasRenderingContext2D,
    d: DrawingObject,
    toPx: (pt: { time: number; price: number }) => Px | null,
    theme: "dark" | "light",
  ): void {
    const handles = drawingHandles(d, toPx);
    if (!handles.length) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme === "light" ? "#212529" : "#ffffff";
    ctx.fillStyle = "#2f81f7";
    for (const h of handles) {
      ctx.beginPath();
      ctx.rect(h.x - 4, h.y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

class DrawingPaneView implements ISeriesPrimitivePaneView {
  constructor(private _renderer: DrawingRenderer) {}
  zOrder(): SeriesPrimitivePaneViewZOrder {
    return "top";
  }
  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class DrawingPrimitive implements ISeriesPrimitive<Time> {
  private _renderer: DrawingRenderer;
  private _paneView: DrawingPaneView;
  private _api: { chart: ChartApi; series: SeriesApi; requestUpdate: () => void } | null = null;

  constructor(provider: () => DrawingRenderState) {
    this._renderer = new DrawingRenderer(provider, () =>
      this._api ? { chart: this._api.chart, series: this._api.series } : null,
    );
    this._paneView = new DrawingPaneView(this._renderer);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._api = { chart: param.chart, series: param.series, requestUpdate: param.requestUpdate };
  }
  detached(): void {
    this._api = null;
  }
  updateAllViews(): void {
    /* renderer reads live state via the provider; nothing cached */
  }
  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }
  // ask the chart to repaint (used for drag preview / selection / add-remove)
  requestUpdate(): void {
    this._api?.requestUpdate();
  }
}
