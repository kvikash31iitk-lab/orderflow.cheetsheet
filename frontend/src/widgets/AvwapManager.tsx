// Anchored VWAP manager popover (opened from the caret next to the AVWAP button).
// Lists every Anchored VWAP instance with hide/show + delete, plus "Add" and
// "Clear all" — the discoverable deletion path the user was missing. Anchored VWAPs
// are indicators under the hood, so hide = toggle enabled, delete = removeIndicator.
import { Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import { useStore } from "../store/useStore";
import { formatIstDateTime } from "../lib/time";

export default function AvwapManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const symbol = useStore((s) => s.symbol);
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const removeAllAnchoredVwaps = useStore((s) => s.removeAllAnchoredVwaps);
  const beginAnchoredVwapPlacement = useStore((s) => s.beginAnchoredVwapPlacement);

  if (!open) return null;
  const avs = indicators.filter((i) => i.kind === "anchored-vwap");

  return (
    <>
      {/* click-away catcher */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="popover absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden">
        <div className="flex items-center justify-between border-b border-terminal-border bg-terminal-bg/30 px-3 py-1.5">
          <span className="section-label">Anchored VWAPs · {avs.length}</span>
          <button onClick={onClose} title="Close" className="row-icon-btn">
            <X size={14} />
          </button>
        </div>

        <div className="max-h-64 overflow-auto">
          {avs.length === 0 && (
            <div className="px-3 py-3 text-center text-[11px] text-terminal-muted">
              None yet — click <span className="font-semibold text-flow-exhaustion">AVWAP</span>, then a candle.
            </div>
          )}
          {avs.map((a) => {
            const anchorTime = Number(a.inputs.anchorTime ?? 0);
            const anchorSym = String(a.inputs.anchorSymbol ?? "");
            const offSymbol = anchorSym && anchorSym !== symbol;
            return (
              <div key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-terminal-border/50">
                <span className={`h-2 w-2 shrink-0 rounded-full ${a.enabled ? "bg-flow-exhaustion" : "bg-terminal-muted"}`} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-semibold ${a.enabled ? "text-terminal-text" : "text-terminal-muted"}`}>
                    {a.name}
                  </div>
                  <div className="truncate text-[10px] text-terminal-muted">
                    {offSymbol
                      ? `on ${anchorSym}`
                      : anchorTime > 0
                        ? `${formatIstDateTime(anchorTime)} IST`
                        : "not anchored"}
                  </div>
                </div>
                <button onClick={() => toggleIndicator(a.id)} title={a.enabled ? "Hide" : "Show"} className="row-icon-btn">
                  {a.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button onClick={() => removeIndicator(a.id)} title="Delete" className="row-icon-btn row-icon-btn-danger">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-terminal-border px-3 py-1.5">
          <button
            onClick={() => {
              beginAnchoredVwapPlacement();
              onClose();
            }}
            className="tbtn !text-flow-exhaustion"
          >
            <Plus size={13} /> Add
          </button>
          <button
            onClick={() => removeAllAnchoredVwaps()}
            disabled={avs.length === 0}
            className="tbtn !text-flow-sellHi hover:!border-flow-sell/50 hover:!bg-flow-sell/10"
          >
            Clear all
          </button>
        </div>
      </div>
    </>
  );
}
