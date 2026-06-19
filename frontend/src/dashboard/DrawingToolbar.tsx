// Left vertical drawing toolbar (TradingView-style). Picks the active drawing tool,
// deletes the selection, clears the symbol's drawings, and opens the Object Tree.
import { useStore } from "../store/useStore";
import { DRAWING_TOOLS } from "../drawings/types";

export default function DrawingToolbar({ onOpenObjects }: { onOpenObjects: () => void }) {
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const selectedId = useStore((s) => s.selectedDrawingId);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const clearDrawings = useStore((s) => s.clearDrawings);
  const symbol = useStore((s) => s.symbol);
  const symbolCount = useStore((s) => s.drawings.filter((d) => d.symbol === symbol).length);

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-terminal-border bg-terminal-panel py-2">
      {DRAWING_TOOLS.map((t) => (
        <button
          key={t.tool}
          onClick={() => setActiveTool(t.tool)}
          title={t.title}
          className={`flex h-8 w-8 items-center justify-center rounded text-sm leading-none ${
            activeTool === t.tool
              ? "bg-flow-delta text-white"
              : "text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
          }`}
        >
          {t.glyph}
        </button>
      ))}

      <div className="my-1 h-px w-6 bg-terminal-border" />

      <button
        onClick={() => selectedId && removeDrawing(selectedId)}
        disabled={!selectedId}
        title="Delete selected drawing (Del)"
        className="flex h-8 w-8 items-center justify-center rounded text-sm leading-none text-flow-sellHi hover:bg-terminal-border disabled:cursor-not-allowed disabled:opacity-30"
      >
        🗑
      </button>
      <button
        onClick={() => {
          if (symbolCount && window.confirm(`Remove all ${symbolCount} drawing(s) on ${symbol}?`)) clearDrawings(symbol);
        }}
        disabled={!symbolCount}
        title="Clear all drawings on this symbol"
        className="flex h-8 w-8 items-center justify-center rounded text-[9px] font-semibold leading-none text-terminal-muted hover:bg-terminal-border hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        CLR
      </button>
      <button
        onClick={onOpenObjects}
        title="Object tree"
        className="flex h-8 w-8 items-center justify-center rounded text-base leading-none text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
      >
        ☰
      </button>
    </div>
  );
}
