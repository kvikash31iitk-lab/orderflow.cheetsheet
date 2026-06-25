// Floating toolbar shown when an Anchored VWAP is selected on the chart (click its
// line in select mode). Mirrors DrawingSelectionToolbar but for the AVWAP indicator:
// re-anchor, toggle SD bands, delete. Selection + deletion stay in sync with the
// Object Tree / Indicators panel because all of them read the same store.
import { Anchor, Trash2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { formatIstDateTime } from "../lib/time";

export default function AvwapSelectionToolbar() {
  const symbol = useStore((s) => s.symbol);
  const selectedIndicatorId = useStore((s) => s.selectedIndicatorId);
  const indicator = useStore((s) =>
    s.indicators.find((i) => i.id === s.selectedIndicatorId && i.kind === "anchored-vwap"),
  );
  const beginAnchorPick = useStore((s) => s.beginIndicatorAnchorPick);
  const updateIndicator = useStore((s) => s.updateIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const selectIndicator = useStore((s) => s.selectIndicator);

  if (!selectedIndicatorId || !indicator) return null;
  // only show when the AVWAP is actually drawn on the current symbol's chart
  const anchorSym = String(indicator.inputs.anchorSymbol || "");
  if (anchorSym && anchorSym !== symbol) return null;

  const anchorMs = Number(indicator.inputs.anchorTime ?? 0);
  const showBands = indicator.inputs.showBands === true;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-terminal-border bg-terminal-panel/95 px-2 py-1 text-xs text-terminal-text shadow-lg shadow-black/40">
        <span className="max-w-[150px] truncate text-[11px] font-semibold text-flow-exhaustion" title={indicator.name}>
          {indicator.name}
        </span>
        {anchorMs > 0 && (
          <span className="hidden items-center gap-1 text-[10px] text-terminal-muted sm:flex">
            <Anchor size={10} /> {formatIstDateTime(anchorMs)} IST
          </span>
        )}
        <button
          onClick={() => beginAnchorPick(indicator.id)}
          title="Re-anchor — then click a candle"
          className="rounded-md border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted transition-colors hover:bg-terminal-border/40 hover:text-terminal-text"
        >
          Re-anchor
        </button>
        <button
          onClick={() => updateIndicator(indicator.id, { inputs: { ...indicator.inputs, showBands: !showBands } })}
          title={showBands ? "Hide SD bands" : "Show SD bands"}
          className={`rounded-md border px-2 py-0.5 text-[11px] ${
            showBands
              ? "border-flow-exhaustion/60 bg-flow-exhaustion/10 text-flow-exhaustion"
              : "border-terminal-border text-terminal-muted transition-colors hover:bg-terminal-border/40 hover:text-terminal-text"
          }`}
        >
          Bands
        </button>
        <button
          onClick={() => selectIndicator(null)}
          title="Deselect (Esc)"
          className="rounded-md border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted transition-colors hover:bg-terminal-border/40 hover:text-terminal-text"
        >
          Done
        </button>
        <button
          onClick={() => removeIndicator(indicator.id)}
          title="Delete this Anchored VWAP (Del)"
          className="flex items-center gap-1 rounded-md border border-flow-sellHi/50 px-2 py-0.5 text-[11px] font-semibold text-flow-sellHi hover:bg-flow-sellHi/10"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}
