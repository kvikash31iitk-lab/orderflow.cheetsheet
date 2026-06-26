// Bar Statistics settings — presets, metric toggles (available vs honestly-disabled),
// number format, and colour intensity. Shares the FloatingWindow + design tokens. Changes
// apply live through the store (persisted). Unavailable metrics render disabled with a hint.
import type { ReactNode } from "react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { BAR_STAT_METRICS, BAR_STAT_PRESETS, type BarStatMetricId, type BarStatNumberFormat } from "../barStats/types";

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 mt-2.5 flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-terminal-muted">{children}</span>
      <div className="h-px flex-1 bg-terminal-border" />
    </div>
  );
}

function Field({ label, children, disabled, tip }: { label: string; children: ReactNode; disabled?: boolean; tip?: string }) {
  return (
    <div title={tip} className={`flex min-h-[26px] items-center justify-between gap-3 ${disabled ? "opacity-45" : ""}`}>
      <span className="truncate text-[12px] text-terminal-text">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-on={on}
      onClick={() => onChange?.(!on)}
      className="switch disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`seg-item ${value === o.value ? "seg-item-on" : ""}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Swatch({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <label className="relative h-5 w-5 cursor-pointer overflow-hidden rounded border border-terminal-border-strong" style={{ background: value || fallback }} title="Pick colour">
        <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      {value ? (
        <button type="button" title="Reset to default" onClick={() => onChange("")} className="text-[10px] leading-none text-terminal-muted hover:text-terminal-text">
          reset
        </button>
      ) : (
        <span className="text-[10px] text-terminal-muted/60">auto</span>
      )}
    </span>
  );
}

const AVAILABLE = BAR_STAT_METRICS.filter((m) => m.available);
const UNAVAILABLE = BAR_STAT_METRICS.filter((m) => !m.available);

export default function BarStatsSettingsModal() {
  const open = useStore((s) => s.barStatsSettingsOpen);
  const setOpen = useStore((s) => s.setBarStatsSettingsOpen);
  const settings = useStore((s) => s.barStatsSettings);
  const setSettings = useStore((s) => s.setBarStatsSettings);
  const reset = useStore((s) => s.resetBarStatsSettings);
  const showBarStats = useStore((s) => s.showBarStats);
  const setShowBarStats = useStore((s) => s.setShowBarStats);

  if (!open) return null;
  const close = () => setOpen(false);

  const toggleMetric = (id: BarStatMetricId, on: boolean) => {
    const cur = settings.enabled;
    const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
    setSettings({ enabled: next, preset: "" });
  };

  return (
    <FloatingWindow
      id="barstats-settings"
      title="Bar Statistics"
      open={open}
      onClose={close}
      defaultRect={{ w: 380, h: 560 }}
      minW={300}
      minH={320}
      bodyClassName="flex min-h-0 flex-col"
      closeOnEscape
    >
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 py-2.5">
        <Field label="Show pane">
          <Switch on={showBarStats} onChange={setShowBarStats} />
        </Field>

        <GroupLabel>Presets</GroupLabel>
        <div className="flex flex-wrap gap-1">
          {BAR_STAT_PRESETS.map((p) => (
            <button
              key={p.name}
              title={p.hint}
              onClick={() => setSettings({ ...p.settings, preset: p.name })}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                settings.preset === p.name
                  ? "border-accent/40 bg-accent/10 text-terminal-text"
                  : "border-terminal-border bg-terminal-bg/60 text-terminal-muted hover:border-accent/40 hover:bg-accent/10 hover:text-terminal-text"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <GroupLabel>Number Format</GroupLabel>
        <Field label="Numbers">
          <Seg
            value={settings.numberFormat}
            onChange={(v) => setSettings({ numberFormat: v as BarStatNumberFormat })}
            options={[
              { value: "compact", label: "1.5K" },
              { value: "absolute", label: "1500" },
            ]}
          />
        </Field>
        <Field label="Percent decimals">
          <Seg
            value={String(settings.percentDecimals)}
            onChange={(v) => setSettings({ percentDecimals: Number(v) })}
            options={[
              { value: "0", label: "0" },
              { value: "1", label: "1" },
              { value: "2", label: "2" },
            ]}
          />
        </Field>

        <GroupLabel>Colors</GroupLabel>
        <Field label="Cell intensity">
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={settings.colorIntensity}
            onChange={(e) => setSettings({ colorIntensity: Number(e.target.value) })}
            className="h-1 w-28 cursor-pointer accent-accent"
          />
        </Field>
        <Field label="Buy / positive">
          <Swatch value={settings.buyColor} fallback="#16c172" onChange={(v) => setSettings({ buyColor: v })} />
        </Field>
        <Field label="Sell / negative">
          <Swatch value={settings.sellColor} fallback="#ef4d63" onChange={(v) => setSettings({ sellColor: v })} />
        </Field>
        <Field label="Neutral">
          <Swatch value={settings.neutralColor} fallback="#2f81f7" onChange={(v) => setSettings({ neutralColor: v })} />
        </Field>

        <GroupLabel>Metrics</GroupLabel>
        {AVAILABLE.map((m) => (
          <Field key={m.id} label={m.label}>
            <Switch on={settings.enabled.includes(m.id)} onChange={(on) => toggleMetric(m.id, on)} />
          </Field>
        ))}

        <GroupLabel>Unavailable · needs extra data</GroupLabel>
        {UNAVAILABLE.map((m) => (
          <Field key={m.id} label={m.label} disabled tip={m.hint}>
            <span className="text-[10px] text-terminal-muted">{m.hint}</span>
          </Field>
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-terminal-border px-3 py-2">
        <button onClick={reset} className="tbtn-link">
          Reset to defaults
        </button>
        <button onClick={close} className="tbtn">
          Close
        </button>
      </div>
    </FloatingWindow>
  );
}
