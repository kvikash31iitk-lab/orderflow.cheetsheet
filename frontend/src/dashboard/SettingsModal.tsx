import type { ReactNode } from "react";
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

// ---- compact building blocks (institutional rows, no bulky cards) ----
const selCls =
  "rounded border border-terminal-border bg-terminal-bg px-1.5 py-0.5 text-[11px] text-terminal-text focus:outline-none focus:border-flow-delta";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-terminal-muted">{title}</span>
        <div className="h-px flex-1 bg-terminal-border" />
      </div>
      {note && <p className="mb-1 text-[10px] leading-tight text-terminal-muted/70">{note}</p>}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, children, disabled, tip }: { label: string; children: ReactNode; disabled?: boolean; tip?: string }) {
  return (
    <label
      title={tip}
      className={`flex min-h-[22px] items-center justify-between gap-2 text-xs ${disabled ? "text-terminal-muted/50" : "text-terminal-text"}`}
    >
      <span className="truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </label>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="h-3.5 w-3.5 cursor-pointer accent-flow-delta disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function ColorSwatch({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        type="color"
        value={value || fallback}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 w-6 cursor-pointer rounded border border-terminal-border bg-transparent p-0"
      />
      {value ? (
        <button
          type="button"
          title="Reset to theme colour"
          onClick={() => onChange("")}
          className="text-[11px] leading-none text-terminal-muted hover:text-terminal-text"
        >
          ×
        </button>
      ) : (
        <span className="w-[10px]" />
      )}
    </>
  );
}

function FormatSelect({ value, onChange }: { value: FootprintTextFormat; onChange: (v: FootprintTextFormat) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as FootprintTextFormat)} className={`${selCls} w-32`}>
      {FOOTPRINT_TEXT_FORMATS.map((f) => (
        <option key={f.value} value={f.value} disabled={!f.supported} title={f.supported ? "" : "Requires trade-count footprint data"}>
          {f.label}
          {f.supported ? "" : " — n/a"}
        </option>
      ))}
    </select>
  );
}

// dark-theme fallbacks shown in the colour picker while a setting is "" (theme-driven)
const FB = {
  imbBuy: "#16c172",
  imbSell: "#ef4d63",
  poc: "#f5d020",
  text: "#c7d0db",
  fill: "#3a4350",
};

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

  const set = (p: Partial<FootprintSettings>) => setSettings(p);
  const double = settings.clusterColumns === "double";

  return (
    <FloatingWindow id="settings" title="⚙️ Footprint Settings" open={open} onClose={onClose} defaultRect={{ w: 344, h: 560 }} minW={300} minH={280}>
      {/* PRESETS */}
      <Section title="Presets">
        <div className="grid grid-cols-3 gap-1">
          {FOOTPRINT_PRESETS.map((p) => (
            <button
              key={p.name}
              title={p.hint}
              onClick={() => {
                setSettings(p.settings);
                if (p.mode) setFootprintMode(p.mode);
              }}
              className="rounded border border-terminal-border px-1.5 py-1 text-[11px] text-terminal-muted hover:border-flow-delta hover:bg-terminal-border hover:text-terminal-text"
            >
              {p.name}
            </button>
          ))}
        </div>
      </Section>

      {/* EDGE */}
      <Section title="Edge">
        <Row label="Last Value">
          <Toggle checked={settings.showLastValue} onChange={(v) => set({ showLastValue: v })} />
        </Row>
        <Row label="Name">
          <Toggle checked={settings.showSeriesName} onChange={(v) => set({ showSeriesName: v })} />
        </Row>
      </Section>

      {/* CLUSTER */}
      <Section title="Cluster">
        <Row label="Show Cluster" tip="Off draws plain candles at footprint zoom">
          <Toggle checked={settings.showCluster} onChange={(v) => set({ showCluster: v })} />
        </Row>
        <Row label="Columns">
          <select
            value={settings.clusterColumns}
            onChange={(e) => set({ clusterColumns: e.target.value as FootprintColumns })}
            className={selCls}
          >
            <option value="single">Single</option>
            <option value="double">Double</option>
          </select>
        </Row>
        {!double && (
          <Row label="Single text">
            <select value={footprintMode} onChange={(e) => setFootprintMode(e.target.value as FootprintMode)} className={selCls}>
              {SINGLE_TEXT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label="Color Matrix">
          <select value={settings.colorMatrix} onChange={(e) => set({ colorMatrix: e.target.value as FootprintColorMatrix })} className={selCls}>
            <option value="default">Default</option>
            <option value="volume">Volume</option>
            <option value="delta">Delta</option>
          </select>
        </Row>
        <Row label="Auto Fontsize">
          <Toggle checked={settings.autoFontSize} onChange={(v) => set({ autoFontSize: v })} />
        </Row>
        {!settings.autoFontSize && (
          <Row label="Font size (px)">
            <input
              type="number"
              min={6}
              max={13}
              step={1}
              value={settings.fixedFontSize}
              onChange={(e) => set({ fixedFontSize: Math.max(6, Math.min(13, Math.round(Number(e.target.value) || 10))) })}
              className={`${selCls} w-14 text-right font-mono`}
            />
          </Row>
        )}
        <Row label="Show Profile" tip="Per-row volume bar inside each cell">
          <Toggle checked={settings.showProfile} onChange={(v) => set({ showProfile: v })} />
        </Row>
      </Section>

      {/* LEFT CLUSTER */}
      <Section title="Left Cluster" note={double ? undefined : "Applies to the left side in Double-column mode"}>
        <Row label="Text Format">
          <FormatSelect value={settings.leftFormat} onChange={(v) => set({ leftFormat: v })} />
        </Row>
        <Row label="Background">
          <Toggle checked={settings.leftBackground} onChange={(v) => set({ leftBackground: v })} />
        </Row>
        <Row label="Fill">
          <ColorSwatch value={settings.leftFill} fallback={FB.fill} onChange={(v) => set({ leftFill: v })} />
        </Row>
        <Row label="Text Color">
          <ColorSwatch value={settings.leftTextColor} fallback={FB.text} onChange={(v) => set({ leftTextColor: v })} />
        </Row>
      </Section>

      {/* RIGHT CLUSTER */}
      <Section title="Right Cluster" note="Used in Double-column mode">
        <Row label="Text Format" disabled={!double}>
          <FormatSelect value={settings.rightFormat} onChange={(v) => set({ rightFormat: v })} />
        </Row>
        <Row label="Background" disabled={!double}>
          <Toggle checked={settings.rightBackground} onChange={(v) => set({ rightBackground: v })} disabled={!double} />
        </Row>
        <Row label="Fill" disabled={!double}>
          <ColorSwatch value={settings.rightFill} fallback={FB.fill} onChange={(v) => set({ rightFill: v })} />
        </Row>
        <Row label="Text Color" disabled={!double}>
          <ColorSwatch value={settings.rightTextColor} fallback={FB.text} onChange={(v) => set({ rightTextColor: v })} />
        </Row>
      </Section>

      {/* IMBALANCE */}
      <Section title="Imbalance">
        <Row label="Show Imbalances">
          <Toggle checked={settings.showImbalances} onChange={(v) => set({ showImbalances: v })} />
        </Row>
        <Row label="Ratio">
          <input
            type="number"
            min={1}
            step={0.1}
            value={settings.imbalanceRatio}
            onChange={(e) => set({ imbalanceRatio: Math.max(1, Number(e.target.value) || 1) })}
            className={`${selCls} w-14 text-right font-mono`}
          />
        </Row>
        <Row label="Min Volume">
          <input
            type="number"
            min={0}
            step={1}
            value={settings.imbalanceMinVolume}
            onChange={(e) => set({ imbalanceMinVolume: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className={`${selCls} w-14 text-right font-mono`}
          />
        </Row>
        <Row label="Buy Color">
          <ColorSwatch value={settings.imbalanceBuyColor} fallback={FB.imbBuy} onChange={(v) => set({ imbalanceBuyColor: v })} />
        </Row>
        <Row label="Sell Color">
          <ColorSwatch value={settings.imbalanceSellColor} fallback={FB.imbSell} onChange={(v) => set({ imbalanceSellColor: v })} />
        </Row>
      </Section>

      {/* LOPSIDED — disabled (no faked analytics) */}
      <Section title="Lopsided Format / Scales" note="Coming soon — needs a lopsided model we don't compute yet.">
        <Row label="Lopsided Format" disabled tip="Coming soon">
          <Toggle checked={false} onChange={() => {}} disabled />
        </Row>
        <Row label="Lopsided Scales" disabled tip="Coming soon">
          <Toggle checked={false} onChange={() => {}} disabled />
        </Row>
      </Section>

      {/* POINT OF CONTROL */}
      <Section title="Point of Control (Volume)">
        <Row label="Show POC">
          <Toggle checked={settings.showPoc} onChange={(v) => set({ showPoc: v })} />
        </Row>
        <Row label="POC Color">
          <ColorSwatch value={settings.pocColor} fallback={FB.poc} onChange={(v) => set({ pocColor: v })} />
        </Row>
        <Row label="POC Marker">
          <Toggle checked={settings.showPocMarker} onChange={(v) => set({ showPocMarker: v })} />
        </Row>
        <Row label="Marker Color">
          <ColorSwatch value={settings.pocMarkerColor} fallback={FB.poc} onChange={(v) => set({ pocMarkerColor: v })} />
        </Row>
        <Row label="Extend POC" tip="Thin line extending the POC level to the right">
          <Toggle checked={settings.extendPoc} onChange={(v) => set({ extendPoc: v })} />
        </Row>
      </Section>

      {/* INDICATOR OVERLAYS (kept from the original panel) */}
      <Section title="Overlays">
        <Row label="VWAP line">
          <Toggle checked={settings.showVwap} onChange={(v) => set({ showVwap: v })} />
        </Row>
        <Row label="SD bands (SD1 & SD2)">
          <Toggle checked={settings.showSdBands} onChange={(v) => set({ showSdBands: v })} />
        </Row>
        <Row label="Signal badges (LP / AD / A / E)">
          <Toggle checked={settings.showBadges} onChange={(v) => set({ showBadges: v })} />
        </Row>
        <Row label="Execution fills">
          <Toggle checked={settings.showFills} onChange={(v) => set({ showFills: v })} />
        </Row>
        <Row label="Thin candle beside footprints">
          <Toggle checked={settings.showThinCandle} onChange={(v) => set({ showThinCandle: v })} />
        </Row>
        <Row label="Block Size (Ticks)">
          <input
            type="number"
            min={1}
            step={1}
            value={settings.tickMultiplier}
            onChange={(e) => set({ tickMultiplier: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
            className={`${selCls} w-14 text-right font-mono`}
          />
        </Row>
        <Row label="Lock Block Size">
          <Toggle checked={settings.lockBlockSize} onChange={(v) => set({ lockBlockSize: v })} />
        </Row>
      </Section>

      <div className="mt-3 flex justify-end border-t border-terminal-border pt-2">
        <button
          onClick={() => resetSettings()}
          title="Reset all footprint settings to defaults"
          className="rounded border border-terminal-border px-2 py-1 text-[11px] text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
        >
          Reset to defaults
        </button>
      </div>
    </FloatingWindow>
  );
}
