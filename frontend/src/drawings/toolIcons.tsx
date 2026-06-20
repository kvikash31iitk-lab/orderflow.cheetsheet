// lucide-react icon mapping for the drawing tools. Kept out of types.ts so that
// module stays a pure (React-free) data/geometry dependency. The toolbar + object
// tree render these instead of box-drawing/mojibake glyphs that don't render in
// every font. vertical-line reuses the horizontal Minus rotated 90deg (see
// VERTICAL_ROTATE) — lucide has no dedicated vertical-rule glyph.
import {
  AlignJustify,
  Brush,
  Minus,
  MousePointer2,
  MoveUpRight,
  Square,
  TrendingUp,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { DrawingTool } from "./types";

export const TOOL_ICONS: Record<DrawingTool, LucideIcon> = {
  select: MousePointer2,
  trendline: TrendingUp,
  ray: MoveUpRight,
  "horizontal-line": Minus,
  "vertical-line": Minus,
  rectangle: Square,
  "fib-retracement": AlignJustify,
  brush: Brush,
  text: Type,
};

// tools whose icon must be rotated to read correctly (vertical line = Minus rotated)
export const VERTICAL_ROTATE: Partial<Record<DrawingTool, boolean>> = {
  "vertical-line": true,
};
