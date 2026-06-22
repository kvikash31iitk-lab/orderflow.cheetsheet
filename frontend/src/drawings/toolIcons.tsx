// Drawing-tool icons. The line-based tools (trendline / ray / horizontal / vertical / fib)
// use crisp custom inline SVGs in a TradingView / GoCharting idiom — thin 1.7 strokes with
// small endpoint handles — because lucide's generic glyphs (TrendingUp zig-zag, Minus dash,
// AlignJustify) read as chart/indicator marks rather than precise drawing tools. The cursor,
// rectangle, brush and text reuse lucide. Every icon shares the (size, strokeWidth, className)
// prop shape so the toolbar and the object tree render them uniformly.
import { Brush, MousePointer2, Square, Type } from "lucide-react";
import type { ReactNode } from "react";
import type { DrawingTool } from "./types";

export type ToolIconProps = { size?: number; strokeWidth?: number; className?: string };
type IconComp = (p: ToolIconProps) => JSX.Element;

function Svg({ size = 18, strokeWidth = 1.7, className, children }: ToolIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const Dot = ({ cx, cy }: { cx: number; cy: number }) => (
  <circle cx={cx} cy={cy} r="1.7" fill="currentColor" stroke="none" />
);

/* ---- custom line tools (endpoint handles distinguish trendline=2 dots vs ray=1 dot) ---- */
const TrendLineIcon: IconComp = (p) => (
  <Svg {...p}><line x1="5" y1="18" x2="19" y2="6" /><Dot cx={5} cy={18} /><Dot cx={19} cy={6} /></Svg>
);
const RayIcon: IconComp = (p) => (
  <Svg {...p}><line x1="4" y1="20" x2="21" y2="3" /><Dot cx={4} cy={20} /></Svg>
);
const HLineIcon: IconComp = (p) => (
  <Svg {...p}><line x1="3" y1="12" x2="21" y2="12" /><Dot cx={12} cy={12} /></Svg>
);
const VLineIcon: IconComp = (p) => (
  <Svg {...p}><line x1="12" y1="3" x2="12" y2="21" /><Dot cx={12} cy={12} /></Svg>
);
const FibIcon: IconComp = (p) => (
  <Svg {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <Dot cx={4} cy={20} /><Dot cx={20} cy={4} />
  </Svg>
);

/* ---- lucide tools wrapped so all entries share one prop shape + a 1.7 default stroke ---- */
const SelectIcon: IconComp = ({ size = 18, strokeWidth = 1.7, className }) =>
  <MousePointer2 size={size} strokeWidth={strokeWidth} className={className} />;
const RectIcon: IconComp = ({ size = 18, strokeWidth = 1.7, className }) =>
  <Square size={size} strokeWidth={strokeWidth} className={className} />;
const BrushIcon: IconComp = ({ size = 18, strokeWidth = 1.7, className }) =>
  <Brush size={size} strokeWidth={strokeWidth} className={className} />;
const TextIcon: IconComp = ({ size = 18, strokeWidth = 1.7, className }) =>
  <Type size={size} strokeWidth={strokeWidth} className={className} />;

export const TOOL_ICONS: Record<DrawingTool, IconComp> = {
  select: SelectIcon,
  trendline: TrendLineIcon,
  ray: RayIcon,
  "horizontal-line": HLineIcon,
  "vertical-line": VLineIcon,
  rectangle: RectIcon,
  "fib-retracement": FibIcon,
  brush: BrushIcon,
  text: TextIcon,
};
