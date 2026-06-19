import { useStore } from "../store/useStore";
import type { FootprintSettings } from "../types/orderflow";

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
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-lg border border-terminal-border bg-terminal-panel p-4 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-terminal-text">⚙️ Footprint Settings</h2>
          <button onClick={onClose} className="text-lg leading-none text-terminal-muted hover:text-terminal-text" title="Close">
            ×
          </button>
        </div>

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

          <label className="flex items-center justify-between gap-2 text-xs text-terminal-muted cursor-pointer">
            <span>Lock Block Size</span>
            <input
              type="checkbox"
              checked={settings.lockBlockSize || false}
              onChange={(e) => setSettings({ lockBlockSize: e.target.checked })}
              className="accent-flow-delta w-4 h-4 cursor-pointer"
            />
          </label>
        </div>

        <div className="my-3 border-t border-terminal-border" />

        {/* Indicator toggles */}
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
      </div>
    </div>
  );
}
