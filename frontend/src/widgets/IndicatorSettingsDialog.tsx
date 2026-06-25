// TradingView-style indicator settings: Inputs / Style / Visibility tabs, with
// Defaults / Cancel / OK. Edits live in local draft state and are NOT committed until
// OK (Cancel/Escape/backdrop discard). Inputs are grouped by key prefix into sections.
import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import CenteredModal from "../components/CenteredModal";
import { parseIndicatorInputs } from "../indicators/runtime";
import { DEFAULT_VISIBILITY, VISIBILITY_CATEGORIES, cloneVisibility } from "../indicators/visibility";
import type { IndicatorInstance, IndicatorVisibility } from "../indicators/types";

type Val = number | string | boolean;
type Tab = "inputs" | "style" | "visibility";

// known string-enum inputs -> select options (current value is always kept selectable)
const ENUMS: Record<string, string[]> = {
  triggerRule: ["any", "two", "all"],
  superMode: ["pine", "composite"],
  i2_counterTrendBlockMode: ["3m only", "5m only", "3m or 5m", "3m and 5m"],
  i3_fvgMitigationMode: ["Close", "Wick"],
  source: ["hlc3", "close", "ohlc4"],
};

// style tab = the marker/display toggles the SC1 scripts expose as boolean inputs
const STYLE_KEYS = [
  "showComponentMarkers", "showI1Markers", "showI2Markers", "showI3Markers",
  "showSuperSignals", "showLowerSourceDebug", "showDebugStrength", "showTrendLines",
  "showBands", "showPoc",
];

function humanize(key: string): string {
  return key
    .replace(/^i[123]_/, "")
    .replace(/^use/, "use ")
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function groupOf(key: string): string {
  if (/^i1_/.test(key)) return "Indicator 1";
  if (/^i2_/.test(key)) return "Indicator 2";
  if (/^i3_/.test(key)) return "Indicator 3";
  if (/^(use5s|min5s|fallback|showLower)/.test(key)) return "5S Orderflow";
  if (/^(enable|trigger|confirm|skip|cooldown|super)/.test(key)) return "Super Signal";
  if (/^(show|display)/.test(key)) return "Display";
  return "General";
}
const GROUP_ORDER = ["Super Signal", "Indicator 1", "Indicator 2", "Indicator 3", "5S Orderflow", "Display", "General"];

function Field({ k, v, onChange }: { k: string; v: Val; onChange: (nv: Val) => void }) {
  const label = <span className="min-w-0 flex-1 truncate text-[11px] text-terminal-muted" title={k}>{humanize(k)}</span>;
  if (typeof v === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3 py-1">
        {label}
        <button type="button" role="switch" aria-checked={v} data-on={v} onClick={() => onChange(!v)} className="switch" title={v ? "On" : "Off"} />
      </div>
    );
  }
  if (typeof v === "number") {
    const isInt = Number.isInteger(v);
    return (
      <label className="flex items-center justify-between gap-3 py-1">
        {label}
        <input
          type="number"
          value={v}
          step={isInt ? 1 : "any"}
          onChange={(e) => onChange(e.target.value === "" ? v : Number(e.target.value))}
          className="tinput w-28"
        />
      </label>
    );
  }
  const opts = ENUMS[k];
  if (opts) {
    const options = opts.includes(v) ? opts : [v, ...opts];
    return (
      <label className="flex items-center justify-between gap-3 py-1">
        {label}
        <select value={v} onChange={(e) => onChange(e.target.value)} className="tsel w-40">
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      {label}
      <input type="text" value={v} onChange={(e) => onChange(e.target.value)} className="tinput w-40 !text-left" />
    </label>
  );
}

function Body({ ind, onClose }: { ind: IndicatorInstance; onClose: () => void }) {
  const updateIndicator = useStore((s) => s.updateIndicator);
  const defaults = useMemo(() => parseIndicatorInputs(ind.script), [ind.script]);
  const [tab, setTab] = useState<Tab>("inputs");
  const [draft, setDraft] = useState<Record<string, Val>>(() => ({ ...defaults, ...ind.inputs }));
  const [vis, setVis] = useState<IndicatorVisibility>(() => cloneVisibility(ind.visibility));

  const keys = Object.keys(draft);
  // Inputs tab shows every input; Style tab is the curated marker/display subset.
  const styleKeys = keys.filter((k) => STYLE_KEYS.includes(k));
  const set = (k: string, nv: Val) => setDraft((d) => ({ ...d, [k]: nv }));

  const grouped = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const k of keys) (g[groupOf(k)] ||= []).push(k);
    return GROUP_ORDER.filter((name) => g[name]?.length).map((name) => ({ name, keys: g[name] }));
  }, [keys.join(",")]);

  const apply = () => {
    updateIndicator(ind.id, { inputs: draft, visibility: vis });
    onClose();
  };
  const resetDefaults = () => {
    setDraft({ ...defaults });
    setVis(cloneVisibility(DEFAULT_VISIBILITY));
  };

  const TabBtn = ({ id, label }: { id: Tab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 text-xs font-medium transition-colors ${tab === id ? "border-b-2 border-accent text-terminal-text" : "text-terminal-muted hover:text-terminal-text"}`}
    >
      {label}
    </button>
  );

  return (
    <CenteredModal
      open
      onClose={onClose}
      title={ind.name}
      widthClass="w-[560px]"
      footer={
        <>
          <button onClick={resetDefaults} className="tbtn mr-auto">Defaults</button>
          <button onClick={onClose} className="tbtn">Cancel</button>
          <button onClick={apply} className="inline-flex h-7 items-center rounded-md bg-accent px-4 text-[12px] font-semibold text-white transition-colors hover:bg-accent/90">
            OK
          </button>
        </>
      }
    >
      <div className="flex items-center gap-1 border-b border-terminal-border px-2">
        <TabBtn id="inputs" label="Inputs" />
        <TabBtn id="style" label="Style" />
        <TabBtn id="visibility" label="Visibility" />
      </div>

      <div className="px-4 py-2">
        {keys.length === 0 && tab === "inputs" && (
          <div className="py-6 text-center text-xs text-terminal-muted">This indicator has no configurable inputs.</div>
        )}

        {tab === "inputs" &&
          grouped.map((grp) => (
            <div key={grp.name} className="mb-2">
              <div className="section-label mb-1 mt-2">{grp.name}</div>
              <div className="divide-y divide-terminal-border/40">
                {grp.keys.map((k) => (
                  <Field key={k} k={k} v={draft[k]} onChange={(nv) => set(k, nv)} />
                ))}
              </div>
            </div>
          ))}

        {tab === "style" && (
          <div className="divide-y divide-terminal-border/40">
            {styleKeys.length === 0 ? (
              <div className="py-6 text-center text-xs text-terminal-muted">
                No style toggles for this indicator. (Marker/line colors are defined by the script.)
              </div>
            ) : (
              styleKeys.map((k) => <Field key={k} k={k} v={draft[k]} onChange={(nv) => set(k, nv)} />)
            )}
            <div className="flex items-center justify-between gap-3 py-1 opacity-70">
              <span className="text-[11px] text-terminal-muted">Overlay (price pane)</span>
              <span className="switch cursor-default" data-on={ind.overlay} title="Defined by the script" />
            </div>
          </div>
        )}

        {tab === "visibility" && (
          <div className="space-y-1 py-1">
            <div className="mb-1 text-[10px] text-terminal-muted">Show this indicator only on the enabled intervals (inclusive range).</div>
            {VISIBILITY_CATEGORIES.map((cat) => {
              const c = vis[cat.key];
              const upd = (patch: Partial<typeof c>) => setVis((p) => ({ ...p, [cat.key]: { ...p[cat.key], ...patch } }));
              return (
                <div key={cat.key} className="flex items-center gap-2 py-1">
                  <div className="flex w-28 items-center gap-2">
                    <button type="button" role="switch" aria-checked={c.enabled} data-on={c.enabled} onClick={() => upd({ enabled: !c.enabled })} className="switch" title={c.enabled ? "Shown" : "Hidden"} />
                    <span className="text-[11px] text-terminal-text">{cat.label}</span>
                  </div>
                  <span className="text-[10px] text-terminal-muted">from</span>
                  <input type="number" min={1} max={cat.max} value={c.from} disabled={!c.enabled || cat.max === 1} onChange={(e) => upd({ from: Math.max(1, Number(e.target.value) || 1) })} className="tinput w-16 disabled:opacity-40" />
                  <span className="text-[10px] text-terminal-muted">to</span>
                  <input type="number" min={1} max={cat.max} value={c.to} disabled={!c.enabled || cat.max === 1} onChange={(e) => upd({ to: Math.max(1, Number(e.target.value) || 1) })} className="tinput w-16 disabled:opacity-40" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </CenteredModal>
  );
}

export default function IndicatorSettingsDialog() {
  const id = useStore((s) => s.settingsIndicatorId);
  const ind = useStore((s) => s.indicators.find((i) => i.id === s.settingsIndicatorId));
  const close = useStore((s) => s.setSettingsIndicatorId);
  if (!id || !ind) return null;
  // key by id so switching target indicators remounts with a fresh draft
  return <Body key={ind.id} ind={ind} onClose={() => close(null)} />;
}
