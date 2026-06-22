// Left vertical drawing toolbar (TradingView / GoCharting-style). Picks the active drawing
// tool, toggles magnet/snap, deletes the selection, clears the symbol's drawings, undo/redo,
// and opens the Object Tree. Compact (40px), monochrome line icons, soft-accent active state.
import { Eraser, ListTree, Magnet, Redo2, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "../store/useStore";
import { DRAWING_TOOLS, SNAP_MODES, type SnapMode } from "../drawings/types";
import { TOOL_ICONS } from "../drawings/toolIcons";

const SNAP_ORDER: SnapMode[] = ["off", "ohlc", "poc", "vwap"];

function ToolBtn({
  active, disabled, danger, title, label, onClick, children,
}: {
  active?: boolean; disabled?: boolean; danger?: boolean;
  title: string; label: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-[30px] w-[30px] items-center justify-center rounded-md transition-colors ${
        disabled
          ? "cursor-not-allowed text-terminal-muted/40"
          : active
          ? "bg-flow-delta/15 text-flow-delta"
          : danger
          ? "text-flow-sellHi/80 hover:bg-terminal-border/60 hover:text-flow-sellHi"
          : "text-terminal-muted hover:bg-terminal-border/60 hover:text-terminal-text"
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="my-0.5 h-px w-5 bg-terminal-border" />;

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
  const snapOn = snapMode !== "off";

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-terminal-border bg-terminal-panel py-1.5">
      {DRAWING_TOOLS.map((t) => {
        const Icon = TOOL_ICONS[t.tool];
        return (
          <ToolBtn
            key={t.tool}
            active={activeTool === t.tool}
            title={t.title}
            label={t.label}
            onClick={() => setActiveTool(t.tool)}
          >
            <Icon size={18} strokeWidth={1.7} />
          </ToolBtn>
        );
      })}

      <Divider />

      {/* magnet / snap mode — cycles off -> OHLC -> POC -> VWAP (label shown when active) */}
      <button
        onClick={cycleSnap}
        title={`Magnet: ${snapDef.label} — ${snapDef.title} (click to cycle)`}
        aria-label={`Magnet snap mode: ${snapDef.label}`}
        aria-pressed={snapOn}
        className={`flex h-[30px] w-[30px] flex-col items-center justify-center rounded-md leading-none transition-colors ${
          snapOn ? "bg-flow-delta/15 text-flow-delta" : "text-terminal-muted hover:bg-terminal-border/60 hover:text-terminal-text"
        }`}
      >
        <Magnet size={16} strokeWidth={1.7} />
        <span className="mt-[1px] text-[7px] font-semibold uppercase tracking-tight">{snapOn ? snapDef.label : ""}</span>
      </button>

      <ToolBtn disabled={!canUndo} title="Undo (Ctrl+Z)" label="Undo" onClick={() => undo()}>
        <Undo2 size={17} strokeWidth={1.7} />
      </ToolBtn>
      <ToolBtn disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)" label="Redo" onClick={() => redo()}>
        <Redo2 size={17} strokeWidth={1.7} />
      </ToolBtn>

      <Divider />

      <ToolBtn
        danger
        disabled={!selectedId}
        title="Delete selected drawing (Del)"
        label="Delete selected drawing"
        onClick={() => selectedId && removeDrawing(selectedId)}
      >
        <Trash2 size={17} strokeWidth={1.7} />
      </ToolBtn>
      <ToolBtn
        disabled={!symbolCount}
        title="Clear all drawings on this symbol"
        label="Clear all drawings"
        onClick={() => {
          if (symbolCount && window.confirm(`Remove all ${symbolCount} drawing(s) on ${symbol}?`)) clearDrawings(symbol);
        }}
      >
        <Eraser size={17} strokeWidth={1.7} />
      </ToolBtn>
      <ToolBtn title="Object tree" label="Open object tree" onClick={onOpenObjects}>
        <ListTree size={17} strokeWidth={1.7} />
      </ToolBtn>
    </div>
  );
}
