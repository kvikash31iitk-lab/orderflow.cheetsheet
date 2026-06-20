import { useStore } from "../store/useStore";
import type { FootprintSettings } from "../types/orderflow";
import FloatingWindow from "../components/FloatingWindow";

const TOGGLES: { key: keyof FootprintSettings; label: string }[] = [
  { key: "showVwap", label: "VWAP line" },
  { key: "showSdBands", label: "SD bands (SD1 & SD2)" },
  { key: "showPoc", label: "Point of Control (POC)" },
  { key: "showImbalances", label: "Imbalance outlines" },
  { key: "showBadges", label: "Signal badges (LP / AD / A / E)" },
  { key: "showFills", label: "Execution fills" },
  { key: "showThinCandle", label: "Thin candle beside footprints" },
];

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const resetSettings = useStore((s) => s.resetSettings);

  return (
    <FloatingWindow
      id="settings"
      title="⚙️ Footprint Settings"
      open={open}
      onClose={onClose}
      defaultRect={{ w: 380, h: 470 }}
      minW={300}
      minH={260}
    >
      {/* Parameters */}
      <div className="space-y-2.5">
        <label className="flex items-center justify-between gap-2 text-xs text-terminal-muted">
          <span>Block Size (Ticks)</span>
          <input
            type="number"
            step="1"
            min="1"
            value={settings.tickMultiplier}
            onChange={(e) => setSettings({ tickMultiplier: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
            className="w-28 rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-right font-mono text-xs text-terminal-text"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-xs text-terminal-muted">
          <span>Imbalance Ratio</span>
          <input
            type="number"
            step="0.1"
            min="1"
            value={settings.imbalanceRatio}
            onChange={(e) => setSettings({ imbalanceRatio: Math.max(1, Number(e.target.value) || 1) })}
            className="w-28 rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-right font-mono text-xs text-terminal-text"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-xs text-terminal-muted">
          <span>Imbalance Min Volume</span>
          <input
            type="number"
            step="1"
            min="0"
            value={settings.imbalanceMinVolume}
            onChange={(e) => setSettings({ imbalanceMinVolume: Math.max(0, Number(e.target.value) || 0) })}
            className="w-28 rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-right font-mono text-xs text-terminal-text"
          />
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-2 text-xs text-terminal-muted">
          <span>Lock Block Size</span>
          <input
            type="checkbox"
            checked={settings.lockBlockSize || false}
            onChange={(e) => setSettings({ lockBlockSize: e.target.checked })}
            className="h-4 w-4 cursor-pointer accent-flow-delta"
          />
        </label>
      </div>

      <div className="my-3 border-t border-terminal-border" />

      {/* Overlay toggles */}
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Indicators</span>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5">
        {TOGGLES.map((t) => (
          <label key={t.key} className="flex cursor-pointer items-center gap-2 text-xs text-terminal-text">
            <input
              type="checkbox"
              checked={settings[t.key] as boolean}
              onChange={(e) => setSettings({ [t.key]: e.target.checked } as Partial<FootprintSettings>)}
              className="accent-flow-delta"
            />
            {t.label}
          </label>
        ))}
      </div>

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
