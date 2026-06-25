// Object Tree — unified, grouped management of everything applied to the chart
// (indicators, anchored VWAPs, drawings), TradingView-style. Lives in a FloatingWindow.
// Every object is selectable, hideable, lockable (drawings) and DELETABLE here. Drawings
// are scoped to the active symbol (they only render on the symbol they were drawn on).
import type { ReactNode } from "react";
import { Anchor, Eye, EyeOff, Lock, LockOpen, Settings, X } from "lucide-react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { TOOL_ICONS } from "../drawings/toolIcons";
import { formatIstDateTime } from "../lib/time";
import type { IndicatorInstance } from "../indicators/types";

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

// One indicator / anchored-VWAP row: enable switch · name (+ anchor time) · settings · remove.
// `selectable` AVWAP rows highlight + select-on-click (they're pickable on the chart).
function IndicatorRow({
  ind,
  selectable,
  selected,
  onSelect,
  onToggle,
  onSettings,
  onRemove,
}: {
  ind: IndicatorInstance;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onToggle: () => void;
  onSettings: () => void;
  onRemove: () => void;
}) {
  const isAvwap = ind.kind === "anchored-vwap";
  const anchorMs = isAvwap ? Number(ind.inputs.anchorTime ?? 0) : 0;
  return (
    <div
      onClick={selectable ? onSelect : undefined}
      className={`flex items-center gap-2 px-3 py-1.5 ${selectable ? "cursor-pointer" : ""} ${
        selected ? "bg-flow-exhaustion/15" : "hover:bg-terminal-border/50"
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={ind.enabled}
        data-on={ind.enabled}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="switch"
        title={ind.enabled ? "Disable" : "Enable"}
      />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${ind.enabled ? "" : "text-terminal-muted"}`}>{ind.name}</div>
        {anchorMs > 0 && (
          <div className="flex items-center gap-1 truncate text-[10px] text-terminal-muted">
            <Anchor size={10} /> {formatIstDateTime(anchorMs)} IST
          </div>
        )}
      </div>
      {!isAvwap && <span className="text-[10px] text-terminal-muted">{ind.overlay ? "overlay" : "pane"}</span>}
      <IconBtn title="Settings" onClick={onSettings}>
        <Settings size={13} />
      </IconBtn>
      <IconBtn title="Remove" onClick={onRemove} danger>
        <X size={13} />
      </IconBtn>
    </div>
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
  const removeAllAnchoredVwaps = useStore((s) => s.removeAllAnchoredVwaps);
  const setSettingsIndicatorId = useStore((s) => s.setSettingsIndicatorId);
  const selectedIndicatorId = useStore((s) => s.selectedIndicatorId);
  const selectIndicator = useStore((s) => s.selectIndicator);

  const symDrawings = drawings.filter((d) => d.symbol === symbol);
  const regular = indicators.filter((i) => i.kind !== "anchored-vwap");
  const avwaps = indicators.filter((i) => i.kind === "anchored-vwap");

  return (
    <FloatingWindow
      id="object-tree"
      title="Objects"
      open={open}
      onClose={onClose}
      defaultRect={{ w: 300, h: 460, x: undefined, y: 90 }}
      minW={240}
      minH={220}
      bodyClassName="p-0"
    >
      <div className="flex flex-col text-xs text-terminal-text">
        <Section title="Indicators">
          {regular.length === 0 && <Empty>No indicators — add one from the ƒx panel.</Empty>}
          {regular.map((i) => (
            <IndicatorRow
              key={i.id}
              ind={i}
              onToggle={() => toggleIndicator(i.id)}
              onSettings={() => setSettingsIndicatorId(i.id)}
              onRemove={() => removeIndicator(i.id)}
            />
          ))}
        </Section>

        <Section
          title="Anchored VWAPs"
          extra={
            avwaps.length ? (
              <button onClick={() => removeAllAnchoredVwaps()} className="tbtn-link hover:text-flow-sellHi">
                clear all
              </button>
            ) : null
          }
        >
          {avwaps.length === 0 && <Empty>None yet — click AVWAP, then a candle.</Empty>}
          {avwaps.map((i) => (
            <IndicatorRow
              key={i.id}
              ind={i}
              selectable
              selected={i.id === selectedIndicatorId}
              onSelect={() => selectIndicator(i.id)}
              onToggle={() => toggleIndicator(i.id)}
              onSettings={() => setSettingsIndicatorId(i.id)}
              onRemove={() => removeIndicator(i.id)}
            />
          ))}
        </Section>

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
                <span
                  className={`flex-1 truncate ${d.visible ? "" : "text-terminal-muted line-through"}`}
                  style={{ color: d.visible ? d.style.color : undefined }}
                >
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
      </div>
    </FloatingWindow>
  );
}
