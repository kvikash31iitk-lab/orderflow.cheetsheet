// Bar Statistics custom-series renderer. Draws a candle-aligned numeric grid (rows = enabled
// metrics, columns = bars) into its own synced sub-pane. Mirrors the footprintSeries custom-
// series scaffolding: a View that hands lightweight-charts a Renderer which paints in media
// (CSS-px) space using each bar's x. One UNIFORM font for the whole view (no per-cell shrink),
// hard-clipped so text never spills; colour intensity is normalised over the VISIBLE bars.
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
import { formatBarStatValue } from "../barStats/barStatsEngine";
import type { BarStatMetricDef, BarStatPoint, BarStatSettings } from "../barStats/types";

const FONT_STACK = "Consolas, monospace";
const PAD_X = 3;
const MIN_FONT = 7;
const MAX_FONT = 12;

export interface BarStatsData extends CustomData<Time> {
  point: BarStatPoint;
}

export interface BarStatsSeriesOptions extends CustomSeriesOptions {
  metrics: BarStatMetricDef[]; // enabled metrics, in row order
  settings: BarStatSettings;
  theme: "dark" | "light";
}

interface Palette {
  buy: string;
  sell: string;
  neutral: string;
  poc: string;
  text: string;
  textMuted: string;
  rowLine: string;
}

function palette(theme: "dark" | "light", s: BarStatSettings): Palette {
  const dark = theme === "dark";
  return {
    buy: s.buyColor || "#16c172",
    sell: s.sellColor || "#ef4d63",
    neutral: s.neutralColor || (dark ? "#3f6ea8" : "#2f81f7"),
    poc: s.pocColor || "#f5d020",
    text: dark ? "#c7d0db" : "#1c2128",
    textMuted: dark ? "#8b97a5" : "#5b6671",
    rowLine: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)",
  };
}

// rgba string from a #rrggbb hex + alpha
function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// cached text measurement (key: fontPx + text). monospace -> width is char-count linear,
// but measure exactly for correctness; bounded so it can't grow unbounded.
const _measure = new Map<string, number>();
function measure(ctx: CanvasRenderingContext2D, fontPx: number, text: string): number {
  const key = `${fontPx} ${text}`;
  const hit = _measure.get(key);
  if (hit !== undefined) return hit;
  ctx.font = `${fontPx}px ${FONT_STACK}`;
  const w = ctx.measureText(text).width;
  if (_measure.size > 4096) _measure.clear();
  _measure.set(key, w);
  return w;
}

class BarStatsRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, BarStatsData> | null = null;
  private _options: BarStatsSeriesOptions | null = null;

  update(data: PaneRendererCustomData<Time, BarStatsData>, options: BarStatsSeriesOptions): void {
    this._data = data;
    this._options = options;
  }

  draw(target: CanvasRenderingTarget2D, _priceToCoordinate: PriceToCoordinateConverter): void {
    target.useMediaCoordinateSpace((scope) => this._draw(scope.context, scope.mediaSize));
  }

  private _draw(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }): void {
    const data = this._data;
    const opts = this._options;
    if (!data || !opts || data.visibleRange === null) return;
    const metrics = opts.metrics;
    if (!metrics.length) return;

    const bars = data.bars;
    const from = Math.max(0, Math.floor(data.visibleRange.from));
    const to = Math.min(bars.length, Math.ceil(data.visibleRange.to));
    if (to <= from) return;

    // bar spacing from any adjacent visible pair (lightweight-charts spaces bars uniformly)
    let barSpacing = 8;
    for (let i = from + 1; i < to; i++) {
      const a = bars[i - 1]?.x;
      const b = bars[i]?.x;
      if (a != null && b != null) {
        barSpacing = Math.abs(b - a);
        break;
      }
    }
    const colW = Math.max(2, barSpacing * 0.9);
    const N = metrics.length;
    const paneH = mediaSize.height;
    const rowH = paneH / N;

    const s = opts.settings;
    const P = palette(opts.theme, s);

    // ---- per-metric visible-range normalisation (for colour intensity) ----
    const norm: { max: number; maxAbs: number }[] = metrics.map(() => ({ max: 1, maxAbs: 1 }));
    for (let i = from; i < to; i++) {
      const pt = bars[i]?.originalData?.point;
      if (!pt) continue;
      for (let r = 0; r < N; r++) {
        const val = pt.values[metrics[r].id];
        if (val == null || !Number.isFinite(val)) continue;
        const n = norm[r];
        if (Math.abs(val) > n.maxAbs) n.maxAbs = Math.abs(val);
        if (val > n.max) n.max = val;
      }
    }

    // ---- ONE uniform font for the whole grid (monospace -> longest string = widest) ----
    let longest = "";
    for (let i = from; i < to; i++) {
      const pt = bars[i]?.originalData?.point;
      if (!pt) continue;
      for (let r = 0; r < N; r++) {
        const t = formatBarStatValue(metrics[r].id, pt.values[metrics[r].id] ?? null, s, pt.dp);
        if (t.length > longest.length) longest = t;
      }
    }
    const availW = colW - 2 * PAD_X;
    let fontPx = Math.min(MAX_FONT, Math.floor(rowH - 4));
    let showText = longest.length > 0 && availW >= 8 && rowH >= MIN_FONT + 2;
    if (showText) {
      const w = measure(ctx, fontPx, longest);
      if (w > availW) fontPx = Math.floor(fontPx * (availW / w)); // one uniform shrink, never per-cell
      if (fontPx < MIN_FONT) showText = false;
    }

    // ---- draw cells ----
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (showText) ctx.font = `${fontPx}px ${FONT_STACK}`;

    for (let r = 0; r < N; r++) {
      const def = metrics[r];
      const rowTop = r * rowH;
      const cy = rowTop + rowH / 2;
      const n = norm[r];
      for (let i = from; i < to; i++) {
        const pt = bars[i]?.originalData?.point;
        const x = bars[i]?.x;
        if (!pt || x == null) continue;
        const val = pt.values[def.id];
        const left = x - colW / 2;

        // cell fill (colour intensity relative to the visible range; price rows stay quiet)
        if (val != null && Number.isFinite(val) && def.role !== "price") {
          let color = P.neutral;
          let intensity = 0;
          if (def.role === "signed") {
            color = val > 0 ? P.buy : val < 0 ? P.sell : P.neutral;
            intensity = Math.abs(val) / n.maxAbs;
          } else if (def.role === "buy") {
            color = P.buy;
            intensity = val / n.max;
          } else if (def.role === "sell") {
            color = P.sell;
            intensity = val / n.max;
          } else {
            color = P.neutral;
            intensity = val / n.max;
          }
          const a = Math.max(0, Math.min(1, intensity)) * s.colorIntensity;
          if (a > 0.01) {
            ctx.fillStyle = rgba(color, a);
            ctx.fillRect(left, rowTop, colW, rowH);
          }
        }

        if (showText) {
          const text = formatBarStatValue(def.id, val ?? null, s, pt.dp);
          if (text) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, rowTop, colW, rowH);
            ctx.clip(); // hard guarantee: nothing escapes the cell
            ctx.fillStyle = def.role === "price" ? P.textMuted : P.text;
            ctx.fillText(text, x, cy);
            ctx.restore();
          }
        }
      }

      // row separator (subtle hairline under each row except the last)
      if (r < N - 1) {
        ctx.strokeStyle = P.rowLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(rowTop + rowH) + 0.5);
        ctx.lineTo(mediaSize.width, Math.round(rowTop + rowH) + 0.5);
        ctx.stroke();
      }
    }
  }
}

export class BarStatsSeriesView
  implements ICustomSeriesPaneView<Time, BarStatsData, BarStatsSeriesOptions>
{
  private _renderer = new BarStatsRenderer();

  renderer(): BarStatsRenderer {
    return this._renderer;
  }

  update(data: PaneRendererCustomData<Time, BarStatsData>, options: BarStatsSeriesOptions): void {
    this._renderer.update(data, options);
  }

  // single trivial price so autoscale stays flat — the renderer draws full-height in media space
  priceValueBuilder(_d: BarStatsData): CustomSeriesPricePlotValues {
    return [0];
  }

  isWhitespace(d: BarStatsData | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> {
    return (d as BarStatsData).point === undefined;
  }

  defaultOptions(): BarStatsSeriesOptions {
    return {
      ...customSeriesDefaultOptions,
      lastValueVisible: false,
      priceLineVisible: false,
      metrics: [],
      settings: {} as BarStatSettings,
      theme: "dark",
    };
  }
}

// concrete series-api type so the pane's applyOptions() accepts the custom fields
export type BarStatsSeriesApi = ISeriesApi<
  "Custom",
  Time,
  BarStatsData | WhitespaceData<Time>,
  BarStatsSeriesOptions,
  SeriesPartialOptions<BarStatsSeriesOptions>
>;
