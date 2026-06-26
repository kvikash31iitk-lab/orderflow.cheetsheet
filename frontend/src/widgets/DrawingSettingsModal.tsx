// Compact style editor for a single drawing, reachable from the drawing right-click menu ("Settings…").
// Complements the inline DrawingSelectionToolbar by exposing fill opacity (filled shapes) and font size
// (text). All edits flow through the existing updateDrawing -> persist path; no new style model.
import type { ReactNode } from "react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { drawingHasStyleEditor, type DrawingStyle, type LineStyleName } from "../drawings/types";

const WIDTHS = [1, 2, 3, 4, 5];
const LINE_STYLES: LineStyleName[] = ["solid", "dashed", "dotted"];
const FONT_SIZES = [10, 12, 14, 16, 20, 24];
const selCls = "h-6 rounded border border-terminal-border bg-terminal-bg px-1 text-[11px] text-terminal-text";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[28px] items-center justify-between gap-3">
      <span className="text-[12px] text-terminal-text">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

export default function DrawingSettingsModal() {
  const id = useStore((s) => s.drawingSettingsId);
  const setId = useStore((s) => s.setDrawingSettingsId);
  const drawing = useStore((s) => s.drawings.find((d) => d.id === s.drawingSettingsId));
  const updateDrawing = useStore((s) => s.updateDrawing);

  // measure renders with a fixed palette its style can't change, so it has no editable settings
  if (!id || !drawing || !drawingHasStyleEditor(drawing.type)) return null;
  const close = () => setId(null);
  const patch = (p: Partial<DrawingStyle>) => updateDrawing(drawing.id, { style: { ...drawing.style, ...p } });
  const s = drawing.style;
  const filled = drawing.type === "rectangle" || drawing.type === "fib-retracement";
  const isText = drawing.type === "text";

  return (
    <FloatingWindow
      id="drawing-settings"
      title={`Settings · ${drawing.name}`}
      open={!!id}
      onClose={close}
      defaultRect={{ w: 300, h: 300, x: undefined, y: 110 }}
      minW={260}
      minH={180}
      bodyClassName="flex min-h-0 flex-col"
      closeOnEscape
    >
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 py-2.5">
        <Field label={isText ? "Text color" : "Color"}>
          <input
            type="color"
            value={s.color}
            onChange={(e) => patch({ color: e.target.value, ...(filled ? { fillColor: e.target.value } : {}) })}
            title="Color"
            className="h-6 w-8 cursor-pointer rounded border border-terminal-border bg-terminal-bg p-0.5"
          />
        </Field>
        {!isText && (
          <Field label="Line width">
            <select value={s.width} onChange={(e) => patch({ width: Number(e.target.value) || 2 })} className={selCls}>
              {WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w}px
                </option>
              ))}
            </select>
          </Field>
        )}
        {!isText && (
          <Field label="Line style">
            <select value={s.lineStyle ?? "solid"} onChange={(e) => patch({ lineStyle: e.target.value as LineStyleName })} className={selCls}>
              {LINE_STYLES.map((ls) => (
                <option key={ls} value={ls}>
                  {ls}
                </option>
              ))}
            </select>
          </Field>
        )}
        {filled && (
          <Field label="Fill opacity">
            <input
              type="range"
              min={0}
              max={0.6}
              step={0.02}
              value={s.fillOpacity ?? 0.12}
              onChange={(e) => patch({ fillOpacity: Number(e.target.value) })}
              className="h-1 w-28 cursor-pointer accent-accent"
            />
          </Field>
        )}
        {isText && (
          <Field label="Font size">
            <select value={s.fontSize ?? 12} onChange={(e) => patch({ fontSize: Number(e.target.value) || 12 })} className={selCls}>
              {FONT_SIZES.map((f) => (
                <option key={f} value={f}>
                  {f}px
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end border-t border-terminal-border px-3 py-2">
        <button onClick={close} className="tbtn">
          Close
        </button>
      </div>
    </FloatingWindow>
  );
}
