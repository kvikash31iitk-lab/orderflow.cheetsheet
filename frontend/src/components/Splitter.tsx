// Thin draggable splitter that resizes an adjacent dashboard panel. Lives in its own
// grid track. Drag to resize; double-click to reset. `invert` flips the drag direction
// for panels that grow toward the splitter (right column grows leftward; CVD/Hist grow
// upward). Clamping is applied here and again in the store action.
import { useRef } from "react";

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

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    start.current = { p: axis === "x" ? e.clientX : e.clientY, v: value };
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
    if (!start.current) return;
    start.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
      className={`${
        axis === "x" ? "cursor-col-resize" : "cursor-row-resize"
      } rounded-full bg-terminal-border/40 transition-colors hover:bg-flow-delta/70`}
    />
  );
}
