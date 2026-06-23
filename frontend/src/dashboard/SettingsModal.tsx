import { useState, type ReactNode } from "react";
import { useStore } from "../store/useStore";
import {
  FOOTPRINT_TEXT_FORMATS,
  type FootprintColorMatrix,
  type FootprintColumns,
  type FootprintMode,
  type FootprintSettings,
  type FootprintTextFormat,
} from "../types/orderflow";
import FloatingWindow from "../components/FloatingWindow";
import { FOOTPRINT_PRESETS } from "./footprintPresets";

// ---- compact inspector building blocks ----
function Field({ label, children, disabled, tip }: { label: string; children: ReactNode; disabled?: boolean; tip?: string }) {
  return (
    <div title={tip} className={`flex min-h-[26px] items-center justify-between gap-3 ${disabled ? "opacity-45" : ""}`}>
      <span className="truncate text-[12px] text-terminal-text">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 mt-2 flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-terminal-muted">{children}</span>
      <div className="h-px flex-1 bg-terminal-border" />
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-on={on}
      onClick={() => onChange(!on)}
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

function NumberField({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => onChange(Number(e.target.value))}
      className="tinput w-16"
    />
  );
}

function Swatch({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <label
        className="relative h-5 w-5 cursor-pointer overflow-hidden rounded border border-terminal-border-strong"
        style={{ background: value || fallback }}
        title="Pick colour"
      >
        <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      {value ? (
        <button type="button" title="Reset to theme colour" onClick={() => onChange("")} className="text-[10px] leading-none text-terminal-muted hover:text-terminal-text">
          reset
        </button>
      ) : (
        <span className="text-[10px] text-terminal-muted/60">auto</span>
      )}
    </span>
  );
}

function FormatSelect({ value, onChange }: { value: FootprintTextFormat; onChange: (v: FootprintTextFormat) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as FootprintTextFormat)} className="tsel w-32 text-[11px]">
      {FOOTPRINT_TEXT_FORMATS.map((f) => (
        <option key={f.value} value={f.value} disabled={!f.supported} title={f.supported ? "" : "Requires trade-count footprint data"}>
          {f.label}
          {f.supported ? "" : " — n/a"}
        </option>
      ))}
    </select>
  );
}

// dark-theme fallbacks shown in the swatch while a setting is "" (theme-driven)
const FB = { imbBuy: "#16c172", imbSell: "#ef4d63", poc: "#f5d020", text: "#c7d0db", fill: "#3a4350" };

const TABS = ["General", "Cluster", "Imbalance", "POC", "Overlays"] as const;
type Tab = (typeof TABS)[number];

const SINGLE_TEXT_MODES: { value: FootprintMode; label: string }[] = [
  { value: "bidAsk", label: "Bid X Ask" },
  { value: "delta", label: "Delta" },
  { value: "volume", label: "Volume" },
  { value: "volumePercent", label: "Volume %" },
];

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const resetSettings = useStore((s) => s.resetSettings);
  const footprintMode = useStore((s) => s.footprintMode);
  const setFootprintMode = useStore((s) => s.setFootprintMode);
  const [tab, setTab] = useState<Tab>("General");

  const set = (p: Partial<FootprintSettings>) => setSettings(p);
  const double = settings.clusterColumns === "double";

  return (
    <FloatingWindow id="settings" title="Footprint Settings" open={open} onClose={onClose} defaultRect={{ w: 396, h: 540 }} minW={320} minH={300} bodyClassName="flex min-h-0 flex-col">
      {/* tab strip */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-terminal-border bg-terminal-bg/30 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              tab === t ? "bg-accent/15 text-accent" : "text-terminal-muted hover:bg-terminal-border/50 hover:text-terminal-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* tab body */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-3 py-2.5">
        {tab === "General" && (
          <>
            <GroupLabel>Presets</GroupLabel>
            <div className="flex flex-wrap gap-1">
              {FOOTPRINT_PRESETS.map((p) => (
                <button
                  key={p.name}
                  title={p.hint}
                  onClick={() => {
                    setSettings(p.settings);
                    if (p.mode) setFootprintMode(p.mode);
                  }}
                  className="rounded-md border border-terminal-border bg-terminal-bg/60 px-2 py-1 text-[11px] font-medium text-terminal-muted transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-terminal-text"
                >
                  {p.name}
                </button>
              ))}
            </div>

            <GroupLabel>Edge</GroupLabel>
            <Field label="Last Value">
              <Toggle on={settings.showLastValue} onChange={(v) => set({ showLastValue: v })} />
            </Field>
            <Field label="Name">
              <Toggle on={settings.showSeriesName} onChange={(v) => set({ showSeriesName: v })} />
            </Field>

            <GroupLabel>Block</GroupLabel>
            <Field label="Block Size (Ticks)">
              <NumberField value={settings.tickMultiplier} min={1} onChange={(v) => set({ tickMultiplier: Math.max(1, Math.floor(v) || 1) })} />
            </Field>
            <Field label="Lock Block Size" tip="Ignore zoom-based auto-consolidation">
              <Toggle on={settings.lockBlockSize} onChange={(v) => set({ lockBlockSize: v })} />
            </Field>
            <Field label="Thin candle beside footprints">
              <Toggle on={settings.showThinCandle} onChange={(v) => set({ showThinCandle: v })} />
            </Field>
          </>
        )}

        {tab === "Cluster" && (
          <>
            <Field label="Show Cluster" tip="Off draws plain candles at footprint zoom">
              <Toggle on={settings.showCluster} onChange={(v) => set({ showCluster: v })} />
            </Field>
            <Field label="Columns">
              <Seg
                value={settings.clusterColumns}
                onChange={(v) => set({ clusterColumns: v as FootprintColumns })}
                options={[
                  { value: "single", label: "Single" },
                  { value: "double", label: "Double" },
                ]}
              />
            </Field>
            {!double && (
              <Field label="Single text">
                <select value={footprintMode} onChange={(e) => setFootprintMode(e.target.value as FootprintMode)} className="tsel text-[11px]">
                  {SINGLE_TEXT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Color Matrix">
              <Seg
                value={settings.colorMatrix}
                onChange={(v) => set({ colorMatrix: v as FootprintColorMatrix })}
                options={[
                  { value: "default", label: "Default" },
                  { value: "volume", label: "Vol" },
                  { value: "delta", label: "Delta" },
                ]}
              />
            </Field>
            <Field label="Auto Fontsize">
              <Toggle on={settings.autoFontSize} onChange={(v) => set({ autoFontSize: v })} />
            </Field>
            {!settings.autoFontSize && (
              <Field label="Font size (px)">
                <NumberField value={settings.fixedFontSize} min={6} max={13} onChange={(v) => set({ fixedFontSize: Math.max(6, Math.min(13, Math.round(v) || 10)) })} />
              </Field>
            )}
            <Field label="Show Profile" tip="Per-row volume bar inside each cell">
              <Toggle on={settings.showProfile} onChange={(v) => set({ showProfile: v })} />
            </Field>

            <GroupLabel>Left Cluster</GroupLabel>
            <Field label="Text Format">
              <FormatSelect value={settings.leftFormat} onChange={(v) => set({ leftFormat: v })} />
            </Field>
            <Field label="Text Color">
              <Swatch value={settings.leftTextColor} fallback={FB.text} onChange={(v) => set({ leftTextColor: v })} />
            </Field>
            <Field label="Background">
              <Toggle on={settings.leftBackground} onChange={(v) => set({ leftBackground: v })} />
            </Field>
            <Field label="Fill">
              <Swatch value={settings.leftFill} fallback={FB.fill} onChange={(v) => set({ leftFill: v })} />
            </Field>

            <GroupLabel>Right Cluster · double-column</GroupLabel>
            <Field label="Text Format" disabled={!double}>
              <FormatSelect value={settings.rightFormat} onChange={(v) => set({ rightFormat: v })} />
            </Field>
            <Field label="Text Color" disabled={!double}>
              <Swatch value={settings.rightTextColor} fallback={FB.text} onChange={(v) => set({ rightTextColor: v })} />
            </Field>
            <Field label="Background" disabled={!double}>
              <Toggle on={settings.rightBackground} onChange={(v) => set({ rightBackground: v })} disabled={!double} />
            </Field>
            <Field label="Fill" disabled={!double}>
              <Swatch value={settings.rightFill} fallback={FB.fill} onChange={(v) => set({ rightFill: v })} />
            </Field>
          </>
        )}

        {tab === "Imbalance" && (
          <>
            <Field label="Show Imbalances">
              <Toggle on={settings.showImbalances} onChange={(v) => set({ showImbalances: v })} />
            </Field>
            <Field label="Ratio">
              <NumberField value={settings.imbalanceRatio} min={1} step={0.1} onChange={(v) => set({ imbalanceRatio: Math.max(1, v || 1) })} />
            </Field>
            <Field label="Min Volume">
              <NumberField value={settings.imbalanceMinVolume} min={0} onChange={(v) => set({ imbalanceMinVolume: Math.max(0, Math.floor(v) || 0) })} />
            </Field>
            <Field label="Buy Color">
              <Swatch value={settings.imbalanceBuyColor} fallback={FB.imbBuy} onChange={(v) => set({ imbalanceBuyColor: v })} />
            </Field>
            <Field label="Sell Color">
              <Swatch value={settings.imbalanceSellColor} fallback={FB.imbSell} onChange={(v) => set({ imbalanceSellColor: v })} />
            </Field>

            <GroupLabel>Lopsided · coming soon</GroupLabel>
            <Field label="Lopsided Format" disabled tip="Needs a lopsided model we don't compute yet">
              <Toggle on={false} onChange={() => {}} disabled />
            </Field>
            <Field label="Lopsided Scales" disabled tip="Needs a lopsided model we don't compute yet">
              <Toggle on={false} onChange={() => {}} disabled />
            </Field>
          </>
        )}

        {tab === "POC" && (
          <>
            <Field label="Show POC">
              <Toggle on={settings.showPoc} onChange={(v) => set({ showPoc: v })} />
            </Field>
            <Field label="POC Color">
              <Swatch value={settings.pocColor} fallback={FB.poc} onChange={(v) => set({ pocColor: v })} />
            </Field>
            <Field label="POC Marker">
              <Toggle on={settings.showPocMarker} onChange={(v) => set({ showPocMarker: v })} />
            </Field>
            <Field label="Marker Color">
              <Swatch value={settings.pocMarkerColor} fallback={FB.poc} onChange={(v) => set({ pocMarkerColor: v })} />
            </Field>
            <Field label="Extend POC" tip="Thin line extending the POC level to the right">
              <Toggle on={settings.extendPoc} onChange={(v) => set({ extendPoc: v })} />
            </Field>
          </>
        )}

        {tab === "Overlays" && (
          <>
            <Field label="VWAP line">
              <Toggle on={settings.showVwap} onChange={(v) => set({ showVwap: v })} />
            </Field>
            <Field label="SD bands (SD1 & SD2)">
              <Toggle on={settings.showSdBands} onChange={(v) => set({ showSdBands: v })} />
            </Field>
            <Field label="Signal badges (LP / AD / A / E)">
              <Toggle on={settings.showBadges} onChange={(v) => set({ showBadges: v })} />
            </Field>
            <Field label="Execution fills">
              <Toggle on={settings.showFills} onChange={(v) => set({ showFills: v })} />
            </Field>
          </>
        )}
      </div>

      {/* footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-terminal-border bg-terminal-bg/30 px-3 py-2">
        <button onClick={() => resetSettings()} className="text-[11px] text-terminal-muted hover:text-terminal-text">
          Reset to defaults
        </button>
        <button onClick={onClose} className="tbtn h-6 px-3 text-[11px]">
          Close
        </button>
      </div>
    </FloatingWindow>
  );
}
