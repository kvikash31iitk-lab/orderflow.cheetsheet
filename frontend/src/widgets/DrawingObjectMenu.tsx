// Right-click menu for a drawing hit directly on the chart canvas. The chart resolves which drawing
// the cursor is over (drawingController.pickObjectAt) and selects it; this renders the actions.
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Copy, Eye, EyeOff, Layers, Lock, LockOpen, MapPin, Trash2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, Submenu, TerminalMenu } from "../components/TerminalContextMenu";
import { formatIstDateTime } from "../lib/time";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function DrawingObjectMenu({ drawingId, x, y, onClose }: { drawingId: string; x: number; y: number; onClose: () => void }) {
  const drawing = useStore((s) => s.drawings.find((d) => d.id === drawingId));
  const toggleVisible = useStore((s) => s.toggleDrawingVisible);
  const toggleLock = useStore((s) => s.toggleDrawingLock);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const reorderDrawing = useStore((s) => s.reorderDrawing);
  if (!drawing) return null;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const pts = drawing.path?.length ? drawing.path : drawing.points;
  const coords = pts.map((p) => `${formatIstDateTime(p.time)} @ ${p.price}`).join("  →  ");
  const summary = `${drawing.name} · ${drawing.type}${pts[0] ? ` @ ${pts[0].price}` : ""}`;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
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
      <Submenu icon={<Layers size={13} />} label="Order">
        <MenuItem icon={<ArrowUpToLine size={13} />} label="Bring to front" onClick={act(() => reorderDrawing(drawing.id, "front"))} />
        <MenuItem icon={<ArrowUp size={13} />} label="Move forward" onClick={act(() => reorderDrawing(drawing.id, "forward"))} />
        <MenuItem icon={<ArrowDown size={13} />} label="Move backward" onClick={act(() => reorderDrawing(drawing.id, "backward"))} />
        <MenuItem icon={<ArrowDownToLine size={13} />} label="Send to back" onClick={act(() => reorderDrawing(drawing.id, "back"))} />
      </Submenu>
      <MenuSeparator />
      <MenuItem icon={<Copy size={13} />} label="Copy summary" onClick={act(() => copyText(summary))} />
      {coords && <MenuItem icon={<MapPin size={13} />} label="Copy coordinates" onClick={act(() => copyText(coords))} />}
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={13} />} label="Delete" danger onClick={act(() => removeDrawing(drawing.id))} />
    </TerminalMenu>
  );
}
