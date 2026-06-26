// TradingView-style three-dot / right-click context menu for one indicator. Built on the shared
// TerminalContextMenu primitives (clamping + dismissal there). Only renders actions that actually do
// something (no silent no-ops).
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Pencil,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";

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

  if (!ind) return null;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <TerminalMenu x={x} y={y} onClose={onClose} minWidth={176}>
      <MenuItem icon={<Settings size={13} />} label="Settings…" onClick={act(() => setSettingsIndicatorId(indicatorId))} />
      <MenuItem icon={<Braces size={13} />} label="Source code…" onClick={act(() => setSourceIndicatorId(indicatorId))} />
      <MenuItem
        icon={ind.enabled ? <EyeOff size={13} /> : <Eye size={13} />}
        label={ind.enabled ? "Hide" : "Show"}
        onClick={act(() => toggleIndicator(indicatorId))}
      />
      <MenuSeparator />
      <MenuItem
        icon={<Pencil size={13} />}
        label="Rename…"
        onClick={act(() => {
          const name = window.prompt("Indicator name:", ind.name);
          if (name && name.trim()) renameIndicator(indicatorId, name);
        })}
      />
      <MenuItem icon={<CopyPlus size={13} />} label="Duplicate" onClick={act(() => duplicateIndicator(indicatorId))} />
      <MenuItem
        icon={<Copy size={13} />}
        label="Copy source"
        onClick={act(() => {
          try {
            void navigator.clipboard?.writeText(ind.script)?.catch(() => {});
          } catch {
            /* clipboard may be unavailable */
          }
        })}
      />
      <MenuItem icon={<RotateCcw size={13} />} label="Reset settings to defaults" onClick={act(() => resetIndicatorInputs(indicatorId))} />
      <MenuSeparator />
      {idx > 0 && <MenuItem icon={<ArrowUp size={13} />} label="Move up" onClick={act(() => moveIndicator(indicatorId, -1))} />}
      {idx >= 0 && idx < indicators.length - 1 && (
        <MenuItem icon={<ArrowDown size={13} />} label="Move down" onClick={act(() => moveIndicator(indicatorId, 1))} />
      )}
      <MenuItem icon={<SlidersHorizontal size={13} />} label="Manage indicators…" onClick={act(() => setIndicatorsPanelOpen(true))} />
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={13} />} label="Remove" danger onClick={act(() => removeIndicator(indicatorId))} />
    </TerminalMenu>
  );
}
