import { useStore } from "../store/useStore";
import type { DrawingStyle, LineStyleName } from "../drawings/types";

const WIDTHS = [1, 2, 3, 4, 5];
const LINE_STYLES: LineStyleName[] = ["solid", "dashed", "dotted"];

export default function DrawingSelectionToolbar() {
  const symbol = useStore((s) => s.symbol);
  const selectedId = useStore((s) => s.selectedDrawingId);
  const drawing = useStore((s) => s.drawings.find((d) => d.id === s.selectedDrawingId && d.symbol === s.symbol));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const toggleVisible = useStore((s) => s.toggleDrawingVisible);
  const toggleLock = useStore((s) => s.toggleDrawingLock);

  if (!selectedId || !drawing || drawing.symbol !== symbol) return null;

  const patchStyle = (patch: Partial<DrawingStyle>) => {
    updateDrawing(drawing.id, { style: { ...drawing.style, ...patch } });
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded border border-terminal-border bg-terminal-panel/95 px-2 py-1 text-xs text-terminal-text shadow-lg shadow-black/40">
        <span className="max-w-[140px] truncate text-[11px] font-semibold text-terminal-muted" title={drawing.name}>
          {drawing.name}
        </span>
        <input
          type="color"
          value={drawing.style.color}
          onChange={(e) => patchStyle({ color: e.target.value, fillColor: e.target.value })}
          title="Color"
          className="h-6 w-7 cursor-pointer rounded border border-terminal-border bg-terminal-bg p-0.5"
        />
        <select
          value={drawing.style.width}
          onChange={(e) => patchStyle({ width: Number(e.target.value) || 2 })}
          title="Line width"
          className="h-6 rounded border border-terminal-border bg-terminal-bg px-1 text-[11px]"
        >
          {WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w}px
            </option>
          ))}
        </select>
        <select
          value={drawing.style.lineStyle ?? "solid"}
          onChange={(e) => patchStyle({ lineStyle: e.target.value as LineStyleName })}
          title="Line style"
          className="h-6 rounded border border-terminal-border bg-terminal-bg px-1 text-[11px]"
        >
          {LINE_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          onClick={() => toggleVisible(drawing.id)}
          title={drawing.visible ? "Hide drawing" : "Show drawing"}
          className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
        >
          {drawing.visible ? "Hide" : "Show"}
        </button>
        <button
          onClick={() => toggleLock(drawing.id)}
          title={drawing.locked ? "Unlock drawing" : "Lock drawing"}
          className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
        >
          {drawing.locked ? "Unlock" : "Lock"}
        </button>
        <button
          onClick={() => removeDrawing(drawing.id)}
          title="Delete drawing"
          className="rounded border border-flow-sellHi/50 px-2 py-0.5 text-[11px] font-semibold text-flow-sellHi hover:bg-flow-sellHi/10"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
