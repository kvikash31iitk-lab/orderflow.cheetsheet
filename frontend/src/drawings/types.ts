// Chart drawing object model.
//
// Drawings are stored in DATA coordinates (epoch-ms `time` + `price`) and scoped
// per `symbol`, so they survive pan / zoom / symbol / timeframe switches and are
// rendered by a single lightweight-charts series primitive (see DrawingPrimitive.ts)
// rather than scattered one-off canvas hacks. The store owns the list + selection;
// the primitive only paints; the controller (drawingController.ts) handles input.

export type DrawingTool =
  | "select"
  | "trendline"
  | "ray"
  | "horizontal-line"
  | "vertical-line"
  | "rectangle"
  | "brush"
  | "fib-retracement"
  | "measure"
  | "text";

// a point in chart data space
export interface ChartPoint {
  time: number; // epoch ms (snapped to a candle.startTime on creation)
  price: number;
}

// Magnet / snap mode for placement: price snaps to the nearest candle feature.
//   off  = free price (time still snaps to the nearest candle as before)
//   ohlc = nearest of the candle's open/high/low/close
//   poc  = the candle's Point of Control (highest-volume price row)
//   vwap = the candle's session VWAP value
export type SnapMode = "off" | "ohlc" | "poc" | "vwap";

export const SNAP_MODES: { mode: SnapMode; label: string; title: string }[] = [
  { mode: "off", label: "Off", title: "Magnet off — free price" },
  { mode: "ohlc", label: "OHLC", title: "Snap price to the nearest candle open/high/low/close" },
  { mode: "poc", label: "POC", title: "Snap price to the candle Point of Control" },
  { mode: "vwap", label: "VWAP", title: "Snap price to the candle session VWAP" },
];

export type LineStyleName = "solid" | "dashed" | "dotted";

export interface DrawingStyle {
  color: string;
  width: number;
  lineStyle?: LineStyleName;
  fillColor?: string;
  fillOpacity?: number;
  fontSize?: number;
}

export interface DrawingObject {
  id: string;
  type: DrawingTool; // never "select" for a committed object
  name: string;
  symbol: string;
  timeframe?: string;
  points: ChartPoint[]; // anchor points (1 or 2 depending on tool)
  path?: ChartPoint[]; // freehand / brush samples
  text?: string;
  visible: boolean;
  locked: boolean;
  selected?: boolean;
  createdAt: number;
  updatedAt: number;
  style: DrawingStyle;
  meta?: Record<string, unknown>;
}

// Fibonacci levels (retracement + extension) from point[0].price -> point[1].price, each with
// a TradingView-style tint used for its level line + the subtle band above it (low opacity, so
// it reads on both light and dark themes). FIB_LEVELS stays as the bare ratio list (used by the
// hit-test + any older callers); FIB_LEVELS_FULL adds per-level color.
export interface FibLevel {
  ratio: number;
  color: string;
}
export const FIB_LEVELS_FULL: FibLevel[] = [
  { ratio: 0, color: "#787b86" },
  { ratio: 0.236, color: "#ef5350" },
  { ratio: 0.382, color: "#ff9800" },
  { ratio: 0.5, color: "#4caf50" },
  { ratio: 0.618, color: "#26a69a" },
  { ratio: 0.786, color: "#42a5f5" },
  { ratio: 1, color: "#787b86" },
  { ratio: 1.272, color: "#42a5f5" },
  { ratio: 1.618, color: "#26a69a" },
  { ratio: 2.618, color: "#ff9800" },
  { ratio: 3.618, color: "#ef5350" },
  { ratio: 4.236, color: "#b39ddb" },
];
export const FIB_LEVELS: number[] = FIB_LEVELS_FULL.map((l) => l.ratio);

export interface DrawingToolDef {
  tool: DrawingTool;
  label: string;
  title: string;
  glyph: string;
  // anchor points needed to create: 1 = single click, 2 = click-drag, 0 = freehand path
  points: 0 | 1 | 2;
}

// Toolbar palette (order = display order). "select" is the idle cursor.
export const DRAWING_TOOLS: DrawingToolDef[] = [
  { tool: "select", label: "Cursor", title: "Select & move (Esc)", glyph: "⌖", points: 0 },
  { tool: "trendline", label: "Trend Line", title: "Trend line — drag from start to end", glyph: "╱", points: 2 },
  { tool: "ray", label: "Ray", title: "Ray — extends past the second point", glyph: "↗", points: 2 },
  { tool: "horizontal-line", label: "Horizontal Line", title: "Horizontal line at a price", glyph: "━", points: 1 },
  { tool: "vertical-line", label: "Vertical Line", title: "Vertical line at a time", glyph: "┃", points: 1 },
  { tool: "rectangle", label: "Rectangle", title: "Rectangle / zone — drag opposite corners", glyph: "▭", points: 2 },
  { tool: "fib-retracement", label: "Fib Retracement", title: "Fibonacci retracement / extension — click start, then end", glyph: "ƒ", points: 2 },
  { tool: "measure", label: "Measure", title: "Measure — price change, %, bars, time & volume between two points", glyph: "⊿", points: 2 },
  { tool: "brush", label: "Brush", title: "Freehand brush", glyph: "✎", points: 0 },
  { tool: "text", label: "Text", title: "Text label", glyph: "T", points: 1 },
];

export function toolDef(tool: DrawingTool): DrawingToolDef | undefined {
  return DRAWING_TOOLS.find((d) => d.tool === tool);
}

// Default style for new drawings (flow.delta accent; theme-independent on purpose so
// a user-picked color is never silently swapped when the theme toggles).
export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  color: "#2f81f7",
  width: 2,
  lineStyle: "solid",
  fillColor: "#2f81f7",
  fillOpacity: 0.12,
  fontSize: 12,
};

export function makeDrawingId(): string {
  return `dr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

// Distinguishable per-type display name ("Trend Line 1", "Rectangle 2", ...).
export function drawingDisplayName(type: DrawingTool, existing: DrawingObject[]): string {
  const def = toolDef(type);
  const base = def ? def.label : type;
  const n = existing.filter((d) => d.type === type).length + 1;
  return `${base} ${n}`;
}

// Number of anchor points a tool needs before it becomes a committed object.
export function pointsForTool(tool: DrawingTool): 0 | 1 | 2 {
  return toolDef(tool)?.points ?? 2;
}

// Whether a drawing's style is user-editable. "measure" renders with a fixed, direction-derived
// palette (DrawingPrimitive ignores its style), so offering a style editor for it would be a dead
// control — callers hide the "Settings…" affordance for these types.
export function drawingHasStyleEditor(type: DrawingTool): boolean {
  return type !== "measure";
}
