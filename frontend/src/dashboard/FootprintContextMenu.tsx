// GoCharting/TradingView-style right-click menu for the footprint chart area. Built on the shared
// TerminalContextMenu primitives — viewport clamping, outside/Escape dismissal and submenu flyouts
// all live there now, so this file is purely the chart's action list.
import {
  BarChart3,
  CandlestickChart,
  Clock,
  Columns3,
  Copy,
  Grid3x3,
  Layers,
  LayoutGrid,
  Maximize2,
  RotateCcw,
  Ruler,
  Settings,
} from "lucide-react";
import { useStore } from "../store/useStore";
import type { FootprintColorMatrix, FootprintColumns, FootprintSettings } from "../types/orderflow";
import { FOOTPRINT_PRESETS } from "./footprintPresets";
import { MenuItem, MenuSeparator, Submenu, TerminalMenu } from "../components/TerminalContextMenu";

const TOGGLES: { key: keyof FootprintSettings; label: string }[] = [
  { key: "showCluster", label: "Show Cluster" },
  { key: "autoFontSize", label: "Auto Fontsize" },
  { key: "showProfile", label: "Show Profile" },
  { key: "showImbalances", label: "Show Imbalances" },
  { key: "showPoc", label: "Show POC" },
  { key: "extendPoc", label: "Extend POC" },
  { key: "showVwap", label: "Show VWAP" },
  { key: "showSdBands", label: "Show SD Bands" },
];

export default function FootprintContextMenu({
  x,
  y,
  price,
  time,
  onResetView,
  onClose,
}: {
  x: number;
  y: number;
  price?: number | null;
  time?: number | null;
  onResetView?: () => void;
  onClose: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const resetSettings = useStore((s) => s.resetSettings);
  const setFootprintMode = useStore((s) => s.setFootprintMode);
  const setFootprintSettingsOpen = useStore((s) => s.setFootprintSettingsOpen);
  const setBlockSizeModalOpen = useStore((s) => s.setBlockSizeModalOpen);
  const chartDisplayMode = useStore((s) => s.chartDisplayMode);
  const setChartDisplayMode = useStore((s) => s.setChartDisplayMode);
  const showBarStats = useStore((s) => s.showBarStats);
  const setShowBarStats = useStore((s) => s.setShowBarStats);
  const setBarStatsSettingsOpen = useStore((s) => s.setBarStatsSettingsOpen);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const copy = (text: string) =>
    act(() => {
      // writeText() rejects ASYNCHRONOUSLY (lost focus / permission / insecure origin); catch the
      // promise too so a failed copy can never surface as an unhandled rejection in the console.
      try {
        void navigator.clipboard?.writeText(text)?.catch(() => {});
      } catch {
        /* clipboard API unavailable */
      }
    });
  const timeStr =
    time != null
      ? new Date(time).toLocaleString("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "";
  const columns: FootprintColumns = settings.clusterColumns;
  const matrix: FootprintColorMatrix = settings.colorMatrix;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<Settings size={13} />} label="Edit Footprint Settings…" onClick={act(() => setFootprintSettingsOpen(true))} />
      {price != null && <MenuItem icon={<Copy size={13} />} label={`Copy price  ${price.toFixed(2)}`} onClick={copy(price.toFixed(2))} />}
      {time != null && <MenuItem icon={<Clock size={13} />} label={`Copy time  ${timeStr}`} onClick={copy(timeStr)} />}
      {price != null && time != null && (
        <MenuItem icon={<Copy size={13} />} label="Copy price + time" onClick={copy(`${price.toFixed(2)}  ${timeStr}`)} />
      )}
      {onResetView && <MenuItem icon={<Maximize2 size={13} />} label="Reset chart view" onClick={act(() => onResetView())} />}
      <MenuItem
        icon={chartDisplayMode === "footprint" ? <CandlestickChart size={13} /> : <LayoutGrid size={13} />}
        label={chartDisplayMode === "footprint" ? "Show as candles" : "Show footprint"}
        onClick={act(() => setChartDisplayMode(chartDisplayMode === "footprint" ? "candle" : "footprint"))}
      />
      <MenuItem
        icon={<BarChart3 size={13} />}
        label={showBarStats ? "Hide Bar Statistics" : "Show Bar Statistics"}
        onClick={act(() => setShowBarStats(!showBarStats))}
      />
      <MenuItem
        icon={<BarChart3 size={13} />}
        label="Bar Statistics Settings…"
        onClick={act(() => {
          setShowBarStats(true);
          setBarStatsSettingsOpen(true);
        })}
      />
      <MenuSeparator />
      <Submenu icon={<Layers size={13} />} label="Apply Preset">
        {FOOTPRINT_PRESETS.map((p) => (
          <MenuItem
            key={p.name}
            label={p.name}
            onClick={act(() => {
              setSettings(p.settings);
              if (p.mode) setFootprintMode(p.mode);
            })}
          />
        ))}
      </Submenu>
      <Submenu icon={<Columns3 size={13} />} label="Columns">
        <MenuItem label="Single" active={columns === "single"} onClick={act(() => setSettings({ clusterColumns: "single" }))} />
        <MenuItem label="Double" active={columns === "double"} onClick={act(() => setSettings({ clusterColumns: "double" }))} />
      </Submenu>
      <Submenu icon={<Grid3x3 size={13} />} label="Color Matrix">
        <MenuItem label="Default" active={matrix === "default"} onClick={act(() => setSettings({ colorMatrix: "default" }))} />
        <MenuItem label="Volume" active={matrix === "volume"} onClick={act(() => setSettings({ colorMatrix: "volume" }))} />
        <MenuItem label="Delta" active={matrix === "delta"} onClick={act(() => setSettings({ colorMatrix: "delta" }))} />
      </Submenu>
      <MenuSeparator />
      {TOGGLES.map((t) => (
        <MenuItem
          key={t.key}
          label={t.label}
          active={settings[t.key] as boolean}
          onClick={() => setSettings({ [t.key]: !(settings[t.key] as boolean) } as Partial<FootprintSettings>)}
        />
      ))}
      <MenuSeparator />
      <MenuItem icon={<Ruler size={13} />} label="Block Size…" onClick={act(() => setBlockSizeModalOpen(true))} />
      <MenuItem icon={<RotateCcw size={13} />} label="Reset Footprint Settings" danger onClick={act(() => resetSettings())} />
    </TerminalMenu>
  );
}
