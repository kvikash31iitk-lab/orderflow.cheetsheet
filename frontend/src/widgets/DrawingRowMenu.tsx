// Right-click menu for a drawing row in the Object Tree. Uses the existing drawing store actions
// (no z-order or per-drawing settings dialog exists, so those are intentionally omitted).
import { Copy, Crosshair, Eye, EyeOff, Lock, LockOpen, Trash2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import type { DrawingObject } from "../drawings/types";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function DrawingRowMenu({ x, y, drawing, onClose }: { x: number; y: number; drawing: DrawingObject; onClose: () => void }) {
  const toggleVisible = useStore((s) => s.toggleDrawingVisible);
  const toggleLock = useStore((s) => s.toggleDrawingLock);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const selectDrawing = useStore((s) => s.selectDrawing);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const p0 = drawing.points[0];
  const summary = `${drawing.name} · ${drawing.type}${p0 ? ` @ ${p0.price}` : ""}`;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem
        icon={<Crosshair size={13} />}
        label="Reveal on chart"
        onClick={act(() => {
          selectDrawing(drawing.id);
          setActiveTool("select");
        })}
      />
      <MenuItem
        icon={drawing.visible ? <EyeOff size={13} /> : <Eye size={13} />}
        label={drawing.visible ? "Hide" : "Show"}
        onClick={act(() => toggleVisible(drawing.id))}
      />
      <MenuItem
        icon={drawing.locked ? <LockOpen size={13} /> : <Lock size={13} />}
        label={drawing.locked ? "Unlock" : "Lock"}
        onClick={act(() => toggleLock(drawing.id))}
      />
      <MenuSeparator />
      <MenuItem icon={<Copy size={13} />} label="Copy summary" onClick={act(() => copyText(summary))} />
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={13} />} label="Delete" danger onClick={act(() => removeDrawing(drawing.id))} />
    </TerminalMenu>
  );
}
