// Object Tree — unified management of everything applied to the chart (drawings +
// indicators), TradingView-style. Lives in a FloatingWindow. Every object is
// selectable, hideable, lockable and DELETABLE here. Drawings are scoped to the
// active symbol (they only render on the symbol they were drawn on).
import type { ReactNode } from "react";
import { Anchor, Eye, EyeOff, Lock, LockOpen, X } from "lucide-react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { TOOL_ICONS } from "../drawings/toolIcons";
import { formatIstDateTime } from "../lib/time";

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-terminal-border">
      <div className="flex items-center justify-between bg-terminal-bg/30 px-3 py-1.5">
        <span className="section-label">{title}</span>
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
      className={`row-icon-btn ${danger ? "row-icon-btn-danger" : ""}`}
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
  const selectedIndicatorId = useStore((s) => s.selectedIndicatorId);
  const selectIndicator = useStore((s) => s.selectIndicator);

  const symDrawings = drawings.filter((d) => d.symbol === symbol);

  return (
    <FloatingWindow
      id="object-tree"
      title="Objects"
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
              <button onClick={() => clearDrawings(symbol)} className="tbtn-link hover:text-flow-sellHi">
                clear all
              </button>
            ) : null
          }
        >
          {symDrawings.length === 0 && <Empty>No drawings yet — pick a tool from the left toolbar.</Empty>}
          {symDrawings.map((d) => {
            const TypeIcon = TOOL_ICONS[d.type];
            return (
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
                <span className="flex w-4 shrink-0 justify-center text-terminal-muted">
                  {TypeIcon && <TypeIcon size={13} />}
                </span>
                <span className={`flex-1 truncate ${d.visible ? "" : "text-terminal-muted line-through"}`} style={{ color: d.visible ? d.style.color : undefined }}>
                  {d.name}
                </span>
                <IconBtn title={d.visible ? "Hide" : "Show"} onClick={() => toggleVisible(d.id)}>
                  {d.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </IconBtn>
                <IconBtn title={d.locked ? "Unlock" : "Lock"} onClick={() => toggleLock(d.id)}>
                  {d.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </IconBtn>
                <IconBtn title="Remove" onClick={() => removeDrawing(d.id)} danger>
                  <X size={13} />
                </IconBtn>
              </div>
            );
          })}
        </Section>

        <Section title="Indicators">
          {indicators.length === 0 && <Empty>No indicators.</Empty>}
          {indicators.map((i) => {
            const isAvwap = i.kind === "anchored-vwap";
            const anchorMs = isAvwap ? Number(i.inputs.anchorTime ?? 0) : 0;
            return (
              <div
                key={i.id}
                onClick={isAvwap ? () => selectIndicator(i.id) : undefined}
                className={`flex items-center gap-2 px-3 py-1.5 ${isAvwap ? "cursor-pointer" : ""} ${
                  i.id === selectedIndicatorId ? "bg-flow-exhaustion/15" : "hover:bg-terminal-border/50"
                }`}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={i.enabled}
                  data-on={i.enabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleIndicator(i.id);
                  }}
                  className="switch"
                  title={i.enabled ? "Disable" : "Enable"}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{i.name}</div>
                  {anchorMs > 0 && (
                    <div className="flex items-center gap-1 truncate text-[10px] text-terminal-muted">
                      <Anchor size={10} /> {formatIstDateTime(anchorMs)} IST
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-terminal-muted">{i.overlay ? "overlay" : "pane"}</span>
                <IconBtn title="Remove" onClick={() => removeIndicator(i.id)} danger>
                  <X size={13} />
                </IconBtn>
              </div>
            );
          })}
        </Section>
      </div>
    </FloatingWindow>
  );
}
