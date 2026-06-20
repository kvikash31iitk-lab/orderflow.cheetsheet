// Left vertical drawing toolbar (TradingView-style). Picks the active drawing tool,
// toggles the magnet/snap mode, deletes the selection, clears the symbol's drawings,
// and opens the Object Tree.
import { Eraser, ListTree, Magnet, Redo2, Trash2, Undo2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { DRAWING_TOOLS, SNAP_MODES, type SnapMode } from "../drawings/types";
import { TOOL_ICONS, VERTICAL_ROTATE } from "../drawings/toolIcons";

const SNAP_ORDER: SnapMode[] = ["off", "ohlc", "poc", "vwap"];

export default function DrawingToolbar({ onOpenObjects }: { onOpenObjects: () => void }) {
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const selectedId = useStore((s) => s.selectedDrawingId);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const clearDrawings = useStore((s) => s.clearDrawings);
  const symbol = useStore((s) => s.symbol);
  const symbolCount = useStore((s) => s.drawings.filter((d) => d.symbol === symbol).length);
  const snapMode = useStore((s) => s.snapMode);
  const setSnapMode = useStore((s) => s.setSnapMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);

  const snapDef = SNAP_MODES.find((m) => m.mode === snapMode) ?? SNAP_MODES[0];
  const cycleSnap = () => setSnapMode(SNAP_ORDER[(SNAP_ORDER.indexOf(snapMode) + 1) % SNAP_ORDER.length]);

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-terminal-border bg-terminal-panel py-2">
      {DRAWING_TOOLS.map((t) => {
        const Icon = TOOL_ICONS[t.tool];
        return (
          <button
            key={t.tool}
            onClick={() => setActiveTool(t.tool)}
            title={t.title}
            aria-label={t.label}
            aria-pressed={activeTool === t.tool}
            className={`flex h-8 w-8 items-center justify-center rounded ${
              activeTool === t.tool
                ? "bg-flow-delta text-white"
                : "text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
            }`}
          >
            <Icon size={16} className={VERTICAL_ROTATE[t.tool] ? "rotate-90" : undefined} />
          </button>
        );
      })}

      <div className="my-1 h-px w-6 bg-terminal-border" />

      {/* magnet / snap mode — cycles off -> OHLC -> POC -> VWAP */}
      <button
        onClick={cycleSnap}
        title={`Magnet: ${snapDef.label} — ${snapDef.title} (click to cycle)`}
        aria-label={`Magnet snap mode: ${snapDef.label}`}
        aria-pressed={snapMode !== "off"}
        className={`flex h-8 w-8 flex-col items-center justify-center rounded leading-none ${
          snapMode !== "off"
            ? "bg-flow-delta text-white"
            : "text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
        }`}
      >
        <Magnet size={15} />
        <span className="mt-0.5 text-[7px] font-semibold uppercase">{snapMode === "off" ? "" : snapDef.label}</span>
      </button>

      <button
        onClick={() => undo()}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
        className="flex h-8 w-8 items-center justify-center rounded text-terminal-muted hover:bg-terminal-border hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Undo2 size={16} />
      </button>
      <button
        onClick={() => redo()}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
        aria-label="Redo"
        className="flex h-8 w-8 items-center justify-center rounded text-terminal-muted hover:bg-terminal-border hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Redo2 size={16} />
      </button>

      <div className="my-1 h-px w-6 bg-terminal-border" />

      <button
        onClick={() => selectedId && removeDrawing(selectedId)}
        disabled={!selectedId}
        title="Delete selected drawing (Del)"
        aria-label="Delete selected drawing"
        className="flex h-8 w-8 items-center justify-center rounded text-flow-sellHi hover:bg-terminal-border disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Trash2 size={16} />
      </button>
      <button
        onClick={() => {
          if (symbolCount && window.confirm(`Remove all ${symbolCount} drawing(s) on ${symbol}?`)) clearDrawings(symbol);
        }}
        disabled={!symbolCount}
        title="Clear all drawings on this symbol"
        aria-label="Clear all drawings"
        className="flex h-8 w-8 items-center justify-center rounded text-terminal-muted hover:bg-terminal-border hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Eraser size={16} />
      </button>
      <button
        onClick={onOpenObjects}
        title="Object tree"
        aria-label="Open object tree"
        className="flex h-8 w-8 items-center justify-center rounded text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
      >
        <ListTree size={16} />
      </button>
    </div>
  );
}
