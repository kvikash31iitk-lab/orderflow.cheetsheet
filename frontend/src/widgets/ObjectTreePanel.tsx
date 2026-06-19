// Object Tree — unified management of everything applied to the chart (drawings +
// indicators), TradingView-style. Lives in a FloatingWindow. Every object is
// selectable, hideable, lockable and DELETABLE here. Drawings are scoped to the
// active symbol (they only render on the symbol they were drawn on).
import type { ReactNode } from "react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { toolDef } from "../drawings/types";

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-terminal-border">
      <div className="flex items-center justify-between bg-terminal-bg/40 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-terminal-muted">{title}</span>
        {extra}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-center text-[11px] text-terminal-muted">{children}</div>;
}

function IconBtn({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex h-5 w-5 items-center justify-center rounded text-[11px] leading-none hover:bg-terminal-border ${
        danger ? "text-flow-sellHi" : "text-terminal-muted hover:text-terminal-text"
      }`}
    >
      {children}
    </button>
  );
}

export default function ObjectTreePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const symbol = useStore((s) => s.symbol);
  const drawings = useStore((s) => s.drawings);
  const selectedId = useStore((s) => s.selectedDrawingId);
  const selectDrawing = useStore((s) => s.selectDrawing);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const toggleVisible = useStore((s) => s.toggleDrawingVisible);
  const toggleLock = useStore((s) => s.toggleDrawingLock);
  const clearDrawings = useStore((s) => s.clearDrawings);
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);

  const symDrawings = drawings.filter((d) => d.symbol === symbol);

  return (
    <FloatingWindow
      id="object-tree"
      title="◳ Objects"
      open={open}
      onClose={onClose}
      defaultRect={{ w: 300, h: 440, x: undefined, y: 90 }}
      minW={240}
      minH={220}
      bodyClassName="p-0"
    >
      <div className="flex flex-col text-xs text-terminal-text">
        <Section
          title={`Drawings · ${symbol}`}
          extra={
            symDrawings.length ? (
              <button
                onClick={() => clearDrawings(symbol)}
                className="text-[10px] text-terminal-muted hover:text-flow-sellHi"
              >
                clear all
              </button>
            ) : null
          }
        >
          {symDrawings.length === 0 && <Empty>No drawings yet — pick a tool from the left toolbar.</Empty>}
          {symDrawings.map((d) => (
            <div
              key={d.id}
              onClick={() => {
                selectDrawing(d.id);
                setActiveTool("select");
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                d.id === selectedId ? "bg-flow-delta/15" : "hover:bg-terminal-border/50"
              }`}
            >
              <span className="w-4 shrink-0 text-center text-terminal-muted">{toolDef(d.type)?.glyph}</span>
              <span className={`flex-1 truncate ${d.visible ? "" : "text-terminal-muted line-through"}`} style={{ color: d.visible ? d.style.color : undefined }}>
                {d.name}
              </span>
              <IconBtn title={d.visible ? "Hide" : "Show"} onClick={() => toggleVisible(d.id)}>
                {d.visible ? "◉" : "○"}
              </IconBtn>
              <IconBtn title={d.locked ? "Unlock" : "Lock"} onClick={() => toggleLock(d.id)}>
                {d.locked ? "🔒" : "🔓"}
              </IconBtn>
              <IconBtn title="Remove" onClick={() => removeDrawing(d.id)} danger>
                ×
              </IconBtn>
            </div>
          ))}
        </Section>

        <Section title="Indicators">
          {indicators.length === 0 && <Empty>No indicators.</Empty>}
          {indicators.map((i) => (
            <div key={i.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-terminal-border/50">
              <input
                type="checkbox"
                checked={i.enabled}
                onChange={() => toggleIndicator(i.id)}
                className="accent-flow-delta"
                title={i.enabled ? "Disable" : "Enable"}
              />
              <span className="flex-1 truncate">{i.name}</span>
              <span className="text-[9px] text-terminal-muted">{i.overlay ? "overlay" : "pane"}</span>
              <IconBtn title="Remove" onClick={() => removeIndicator(i.id)} danger>
                ×
              </IconBtn>
            </div>
          ))}
        </Section>
      </div>
    </FloatingWindow>
  );
}
