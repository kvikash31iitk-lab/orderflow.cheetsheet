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
import { FIB_LEVELS } from "./types";
import { drawingHandles, type Px } from "./geometry";

type ChartApi = SeriesAttachedParameter<Time>["chart"];
type SeriesApi = SeriesAttachedParameter<Time>["series"];

export interface DrawingRenderState {
  drawings: DrawingObject[]; // already filtered to current symbol + visible, draft merged in
  selectedId: string | null;
  theme: "dark" | "light";
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
    if (!state.drawings.length) return;
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
      this._drawOne(ctx, size, d, toX, toY);
      ctx.restore();
    }

    // selection handles painted last, on top
    const sel = state.drawings.find((d) => d.id === state.selectedId);
    if (sel) this._drawHandles(ctx, sel, toPx, state.theme);
  }

  private _drawOne(
    ctx: CanvasRenderingContext2D,
    size: { width: number; height: number },
    d: DrawingObject,
    toX: (t: number) => number | null,
    toY: (p: number) => number | null,
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
        const a = p[0] ? toX(p[0].time) : null;
        const ay = p[0] ? toY(p[0].price) : null;
        const b = p[1] ? toX(p[1].time) : null;
        const by = p[1] ? toY(p[1].price) : null;
        if (a == null || ay == null || b == null || by == null) return;
        const x0 = Math.min(a, b);
        const x1 = Math.max(a, b);
        const price0 = p[0]!.price;
        const price1 = p[1]!.price;
        ctx.font = "10px Consolas, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (const lvl of FIB_LEVELS) {
          const y = ay + (by - ay) * lvl;
          const price = price0 + (price1 - price0) * lvl;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.fillStyle = d.style.color;
          ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${price.toFixed(2)}`, x1 + 4, y);
        }
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
