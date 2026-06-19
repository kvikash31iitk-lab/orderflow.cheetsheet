// Anchored VWAP manager popover (opened from the caret next to the AVWAP button).
// Lists every Anchored VWAP instance with hide/show + delete, plus "Add" and
// "Clear all" — the discoverable deletion path the user was missing. Anchored VWAPs
// are indicators under the hood, so hide = toggle enabled, delete = removeIndicator.
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
      <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between border-b border-terminal-border bg-terminal-bg/40 px-3 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-terminal-muted">
            Anchored VWAPs ({avs.length})
          </span>
          <button onClick={onClose} title="Close" className="text-sm leading-none text-terminal-muted hover:text-terminal-text">
            ×
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
              <div key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-terminal-border/40">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.enabled ? "#f59e0b" : "#6b7785" }} />
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
                <button
                  onClick={() => toggleIndicator(a.id)}
                  title={a.enabled ? "Hide" : "Show"}
                  className="rounded px-1 text-[11px] text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
                >
                  {a.enabled ? "◉" : "○"}
                </button>
                <button
                  onClick={() => removeIndicator(a.id)}
                  title="Delete"
                  className="rounded px-1 text-[11px] text-flow-sellHi hover:bg-flow-sellHi/10"
                >
                  ×
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
            className="rounded border border-terminal-border px-2 py-0.5 text-[11px] font-semibold text-flow-exhaustion hover:bg-terminal-border"
          >
            + Add
          </button>
          <button
            onClick={() => removeAllAnchoredVwaps()}
            disabled={avs.length === 0}
            className="rounded border border-flow-sellHi/40 px-2 py-0.5 text-[11px] font-semibold text-flow-sellHi hover:bg-flow-sellHi/10 disabled:cursor-not-allowed disabled:opacity-30"
          >
            Clear all
          </button>
        </div>
      </div>
    </>
  );
}
