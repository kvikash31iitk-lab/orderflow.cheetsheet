// TradingView-style three-dot context menu for one indicator. Anchored at the click
// point; closes on outside pointer-down, Escape, or after any action. Only renders
// actions that actually do something (no silent no-ops).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, Braces, Copy, CopyPlus, Eye, EyeOff, Pencil, RotateCcw, Settings, SlidersHorizontal, Trash2,
} from "lucide-react";
import { useStore } from "../store/useStore";

function Item({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
        danger ? "text-flow-sellHi hover:bg-flow-sellHi/10" : "text-terminal-text hover:bg-terminal-border/60"
      }`}
    >
      <span className="flex w-4 shrink-0 justify-center text-terminal-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export default function IndicatorContextMenu({
  indicatorId,
  x,
  y,
  onClose,
}: {
  indicatorId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const indicators = useStore((s) => s.indicators);
  const ind = indicators.find((i) => i.id === indicatorId);
  const idx = indicators.findIndex((i) => i.id === indicatorId);

  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const moveIndicator = useStore((s) => s.moveIndicator);
  const duplicateIndicator = useStore((s) => s.duplicateIndicator);
  const renameIndicator = useStore((s) => s.renameIndicator);
  const resetIndicatorInputs = useStore((s) => s.resetIndicatorInputs);
  const setSettingsIndicatorId = useStore((s) => s.setSettingsIndicatorId);
  const setSourceIndicatorId = useStore((s) => s.setSourceIndicatorId);
  const setIndicatorsPanelOpen = useStore((s) => s.setIndicatorsPanelOpen);

  // clamp into the viewport (flip up/left near edges) after measuring
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top });
  }, [x, y]);

  // attach dismissal listeners ONCE (deps []) via a ref to the latest onClose, so the
  // frequent parent re-renders (indicator recompute) can't thrash the listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    // attach synchronously (the opening click's pointerdown already fired before this
    // effect runs, so it can't self-close)
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!ind) return null;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="fixed z-[120] min-w-[176px] overflow-hidden rounded-md border border-terminal-border bg-terminal-panel py-1 shadow-2xl shadow-black/50"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Item icon={<Settings size={13} />} label="Settings…" onClick={act(() => setSettingsIndicatorId(indicatorId))} />
      <Item icon={<Braces size={13} />} label="Source code…" onClick={act(() => setSourceIndicatorId(indicatorId))} />
      <Item
        icon={ind.enabled ? <EyeOff size={13} /> : <Eye size={13} />}
        label={ind.enabled ? "Hide" : "Show"}
        onClick={act(() => toggleIndicator(indicatorId))}
      />
      <div className="my-1 h-px bg-terminal-border" />
      <Item icon={<Pencil size={13} />} label="Rename…" onClick={act(() => {
        const name = window.prompt("Indicator name:", ind.name);
        if (name && name.trim()) renameIndicator(indicatorId, name);
      })} />
      <Item icon={<CopyPlus size={13} />} label="Duplicate" onClick={act(() => duplicateIndicator(indicatorId))} />
      <Item icon={<Copy size={13} />} label="Copy source" onClick={act(() => {
        try {
          void navigator.clipboard?.writeText(ind.script);
        } catch {
          /* clipboard may be unavailable */
        }
      })} />
      <Item icon={<RotateCcw size={13} />} label="Reset settings to defaults" onClick={act(() => resetIndicatorInputs(indicatorId))} />
      <div className="my-1 h-px bg-terminal-border" />
      {idx > 0 && <Item icon={<ArrowUp size={13} />} label="Move up" onClick={act(() => moveIndicator(indicatorId, -1))} />}
      {idx >= 0 && idx < indicators.length - 1 && (
        <Item icon={<ArrowDown size={13} />} label="Move down" onClick={act(() => moveIndicator(indicatorId, 1))} />
      )}
      <Item icon={<SlidersHorizontal size={13} />} label="Manage indicators…" onClick={act(() => setIndicatorsPanelOpen(true))} />
      <div className="my-1 h-px bg-terminal-border" />
      <Item icon={<Trash2 size={13} />} label="Remove" danger onClick={act(() => removeIndicator(indicatorId))} />
    </div>
  );
}
