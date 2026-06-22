// Thin draggable splitter that resizes an adjacent dashboard panel. Lives in its own
// grid track (a wide invisible hit area) but paints only a 1px hairline, so panes read as
// professional charting panes separated by a thin line — not a chunky bar. The hairline
// picks up a subtle accent on hover/drag. Drag to resize; double-click to reset. `invert`
// flips the drag direction for panels that grow toward the splitter (right column grows
// leftward; CVD/Hist grow upward). Clamping is applied here and again in the store action.
import { useRef, useState } from "react";

export default function Splitter({
  axis,
  value,
  min,
  max,
  invert,
  onChange,
  onReset,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ p: number; v: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    start.current = { p: axis === "x" ? e.clientX : e.clientY, v: value };
    setDragging(true);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable */
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const cur = axis === "x" ? e.clientX : e.clientY;
    let d = cur - start.current.p;
    if (invert) d = -d;
    onChange(Math.max(min, Math.min(max, start.current.v + d)));
  };
  const onUp = (e: React.PointerEvent) => {
    setDragging(false);
    if (!start.current) return;
    start.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const isX = axis === "x";
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
      className={`group flex items-center justify-center ${
        isX ? "cursor-col-resize" : "cursor-row-resize"
      }`}
    >
      {/* the only painted pixels: a 1px hairline; subtle accent on hover/drag */}
      <span
        className={`pointer-events-none transition-colors ${isX ? "h-full w-px" : "h-px w-full"} ${
          dragging ? "bg-flow-delta/70" : "bg-terminal-border group-hover:bg-flow-delta/50"
        }`}
      />
    </div>
  );
}
