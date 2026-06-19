import { useState } from "react";
import { useStore } from "../store/useStore";
import { EXAMPLES } from "../indicators/examples";
import type { IndicatorExecutionMode } from "../indicators/types";

const MODES: { value: IndicatorExecutionMode; label: string; hint: string }[] = [
  { value: "sandbox", label: "Sandbox", hint: "Web Worker, isolated + timed out" },
  { value: "direct", label: "Direct", hint: "Main thread — trusted, no isolation" },
  { value: "disabled", label: "Disabled", hint: "Indicators off" },
];

export default function IndicatorsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const indicators = useStore((s) => s.indicators);
  const mode = useStore((s) => s.indicatorExecutionMode);
  const busy = useStore((s) => s.indicatorBusy);
  const errors = useStore((s) => s.indicatorErrors);
  const addIndicator = useStore((s) => s.addIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const updateIndicator = useStore((s) => s.updateIndicator);
  const setMode = useStore((s) => s.setIndicatorExecutionMode);
  const symbol = useStore((s) => s.symbol);
  const beginAnchorPick = useStore((s) => s.beginIndicatorAnchorPick);
  const setIndicatorAnchor = useStore((s) => s.setIndicatorAnchor);

  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editScript, setEditScript] = useState("");

  if (!open) return null;

  const startEdit = (id: string, script: string) => {
    setEditingId(id);
    setEditScript(script);
  };
  const saveEdit = () => {
    if (editingId) updateIndicator(editingId, { script: editScript });
    setEditingId(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[640px] max-w-[94vw] flex-col rounded-lg border border-terminal-border bg-terminal-panel p-4 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-terminal-text">ƒx Indicators</h2>
            {busy && <span className="text-[10px] text-flow-exhaustion">running…</span>}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as IndicatorExecutionMode)}
              title={MODES.find((m) => m.value === mode)?.hint}
              className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs text-terminal-text"
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button onClick={onClose} className="text-lg leading-none text-terminal-muted hover:text-terminal-text" title="Close">
              ×
            </button>
          </div>
        </div>

        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Add example:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              onClick={() => addIndicator(ex.script)}
              className="rounded border border-terminal-border bg-terminal-bg px-2 py-0.5 text-[11px] font-semibold text-flow-buyHi hover:bg-terminal-border"
            >
              + {ex.name}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
          {indicators.length === 0 && (
            <div className="py-4 text-center text-xs text-terminal-muted">No indicators. Add an example above.</div>
          )}
          {indicators.map((ind) => {
            const err = errors[ind.id] ?? ind.lastError ?? null;
            const isAvwap = ind.kind === "anchored-vwap" || ind.name === "Anchored VWAP";
            const anchorTime = Number(ind.inputs.anchorTime ?? 0);
            const anchorSym = String(ind.inputs.anchorSymbol ?? "");
            const anchorStatus = !isAvwap
              ? null
              : !(anchorTime > 0)
                ? { ok: false, text: "No anchor — click Pick Anchor, then click a candle" }
                : anchorSym && anchorSym !== symbol
                  ? { ok: false, text: `Anchor on ${anchorSym} — pick again for ${symbol}` }
                  : { ok: true, text: `Anchored: ${new Date(anchorTime).toLocaleString()}` };
            return (
              <div key={ind.id} className="rounded border border-terminal-border bg-terminal-bg/40 p-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex min-w-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={ind.enabled}
                      onChange={() => toggleIndicator(ind.id)}
                      className="accent-flow-delta"
                    />
                    <span className="truncate font-semibold text-terminal-text">{ind.name}</span>
                    <span className="text-[9px] text-terminal-muted">{ind.overlay ? "overlay" : "pane"}</span>
                  </label>
                  <div className="flex items-center gap-2">
                    {isAvwap && (
                      <>
                        <button
                          onClick={() => {
                            beginAnchorPick(ind.id);
                            onClose();
                          }}
                          title="Pick an anchor: closes this panel, then click a candle on the chart"
                          className="rounded border border-flow-exhaustion/50 px-1.5 py-0.5 text-[10px] font-semibold text-flow-exhaustion hover:bg-terminal-border"
                        >
                          Pick Anchor
                        </button>
                        {anchorTime > 0 && (
                          <button
                            onClick={() => setIndicatorAnchor(ind.id, 0, "")}
                            className="text-[11px] text-terminal-muted hover:text-terminal-text"
                          >
                            clear
                          </button>
                        )}
                      </>
                    )}
                    <button
                      onClick={() => (editingId === ind.id ? setEditingId(null) : startEdit(ind.id, ind.script))}
                      className="text-[11px] text-terminal-muted hover:text-terminal-text"
                    >
                      {editingId === ind.id ? "cancel" : "edit"}
                    </button>
                    <button
                      onClick={() => removeIndicator(ind.id)}
                      className="text-[11px] text-flow-sellHi hover:underline"
                    >
                      remove
                    </button>
                  </div>
                </div>
                {anchorStatus && (
                  <div
                    className={`mt-1 text-[10px] ${anchorStatus.ok ? "text-terminal-muted" : "text-flow-exhaustion"}`}
                  >
                    {anchorStatus.text}
                  </div>
                )}
                {err && (
                  <div className="mt-1 break-words rounded bg-flow-sellHi/10 px-1.5 py-0.5 text-[10px] text-flow-sellHi">
                    {err}
                  </div>
                )}
                {editingId === ind.id && (
                  <div className="mt-2">
                    <textarea
                      value={editScript}
                      onChange={(e) => setEditScript(e.target.value)}
                      spellCheck={false}
                      className="h-48 w-full rounded border border-terminal-border bg-terminal-bg p-2 font-mono text-[11px] text-terminal-text"
                    />
                    <div className="mt-1 flex justify-end">
                      <button
                        onClick={saveEdit}
                        className="rounded bg-flow-delta px-3 py-1 text-xs font-semibold text-white"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 border-t border-terminal-border pt-2">
          <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Add custom script</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder={'indicator("My Indicator", { overlay: true, onCandle(ctx) { /* ... */ } });'}
            className="mt-1 h-28 w-full rounded border border-terminal-border bg-terminal-bg p-2 font-mono text-[11px] text-terminal-text placeholder:text-terminal-muted"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[9px] text-terminal-muted">
              API: indicator(), ctx.shape/zone/plotLine, sma/ema/highest/lowest/sum/change/crossOver/crossUnder
            </span>
            <button
              onClick={() => {
                if (draft.trim()) {
                  addIndicator(draft);
                  setDraft("");
                }
              }}
              className="rounded bg-flow-delta px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
              disabled={!draft.trim()}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
