import { useEffect, useState } from "react";
import { api } from "../api/rest";
import { wsClient } from "../api/ws";
import { useStore } from "../store/useStore";
import type { FootprintMode } from "../types/orderflow";
import ConnectionStatus from "../widgets/ConnectionStatus";
import SettingsModal from "./SettingsModal";
import IndicatorsPanel from "../widgets/IndicatorsPanel";
import AvwapManager from "../widgets/AvwapManager";

const DEFAULT_TFS = ["tick", "1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"];

const FOOTPRINT_MODES: { value: FootprintMode; label: string }[] = [
  { value: "bidAsk", label: "Bid/Ask" },
  { value: "delta", label: "Delta" },
  { value: "volume", label: "Volume" },
  { value: "volumePercent", label: "Volume %" },
];

const CONSOLIDATIONS: { value: number; label: string }[] = [
  { value: 1, label: "1x (Default)" },
  { value: 2, label: "2x" },
  { value: 4, label: "4x" },
  { value: 10, label: "10x" },
];

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase text-terminal-muted">{label}</span>
      <span className={`text-sm font-semibold ${color ?? ""}`}>{value}</span>
    </div>
  );
}

export default function Header() {
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const status = useStore((s) => s.status);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const setSymbol = useStore((s) => s.setSymbol);
  const setTimeframe = useStore((s) => s.setTimeframe);
  const footprintMode = useStore((s) => s.footprintMode);
  const setFootprintMode = useStore((s) => s.setFootprintMode);
  const consolidation = useStore((s) => s.consolidation);
  const setConsolidation = useStore((s) => s.setConsolidation);
  const chartDisplayMode = useStore((s) => s.chartDisplayMode);
  const setChartDisplayMode = useStore((s) => s.setChartDisplayMode);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const settings = useStore((s) => s.settings);
  const setBlockSizeModalOpen = useStore((s) => s.setBlockSizeModalOpen);
  const setSettings = useStore((s) => s.setSettings);
  const candles = useStore((s) => s.candles);
  const pendingAnchorTool = useStore((s) => s.pendingAnchorTool);
  const beginAnchoredVwapPlacement = useStore((s) => s.beginAnchoredVwapPlacement);
  const cancelAnchorPick = useStore((s) => s.cancelIndicatorAnchorPick);
  const avwapCount = useStore((s) => s.indicators.filter((i) => i.kind === "anchored-vwap").length);
  const [symbols, setSymbols] = useState<string[]>(["NIFTY-I", "BANKNIFTY-I", "FINNIFTY-I", "MIDCPNIFTY-I"]);
  const [tfs, setTfs] = useState<string[]>(DEFAULT_TFS);
  // footprint Settings modal open state lives in the store so the chart right-click menu
  // can also open it; the top-toolbar gear still drives it exactly as before.
  const settingsOpen = useStore((s) => s.footprintSettingsOpen);
  const setFootprintSettingsOpen = useStore((s) => s.setFootprintSettingsOpen);
  // ƒx panel open state lives in the store so the on-chart indicator legend / context
  // menu can also open it ("Manage indicators").
  const indicatorsOpen = useStore((s) => s.indicatorsPanelOpen);
  const setIndicatorsOpen = useStore((s) => s.setIndicatorsPanelOpen);
  const [avwapMgrOpen, setAvwapMgrOpen] = useState(false);

  useEffect(() => {
    api.symbols().then((r) => r.symbols?.length && setSymbols(r.symbols)).catch(() => {});
    api.timeframes().then((r) => r.timeframes?.length && setTfs(r.timeframes)).catch(() => {});
  }, []);

  useEffect(() => {
    // re-subscribe on symbol/timeframe/consolidation change (rowSize is derived
    // from symbol + consolidation inside wsClient.subscribe)
    wsClient.subscribe(symbol, timeframe);
  }, [symbol, timeframe, consolidation]);

  const last = candles[candles.length - 1];
  const delta = last?.delta ?? 0;
  const cum = last?.cumDelta ?? 0;

  // CME/COMEX futures served by DataBento (compared upper-cased, so continuous
  // forms like 6E.v.0 match 6E.V.0).
  const databentoSymbols = ["6E.V.0", "GC.V.0", "6E.v.0", "GC.v.0"];
  const partitioned = symbols.filter((s) => {
    const isDb = databentoSymbols.includes(s.toUpperCase());
    return source === "databento" ? isDb : !isDb;
  });
  // never render an empty dropdown (e.g. non-default DATABENTO_SYMBOLS) — fall back to all
  const filteredSymbols = partitioned.length > 0 ? partitioned : symbols;

  return (
    <>
    <header className="flex items-center gap-4 border-b border-terminal-border bg-terminal-panel px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-base font-bold tracking-wide text-flow-buyHi">VIKINGS</span>
        <span className="text-[10px] text-terminal-muted">Order Flow Terminal</span>
      </div>

      <select
        value={source}
        onChange={(e) => setSource(e.target.value as "truedata" | "databento")}
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-sm font-semibold text-flow-buyHi"
        title="Select Data Source"
      >
        <option value="truedata">TrueData</option>
        <option value="databento">DataBento</option>
      </select>

      <select
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-sm font-semibold"
      >
        {filteredSymbols.map((s) => {
          // for DataBento, badge each symbol live (🟢) vs simulated (🔵 no entitlement)
          const isSim = status?.simSymbols?.includes(s.toUpperCase()) ?? false;
          const badge = source === "databento" ? (isSim ? " 🔵 sim" : " 🟢") : "";
          return (
            <option key={s} value={s}>
              {s}{badge}
            </option>
          );
        })}
      </select>

      <div className="flex items-center gap-0.5">
        {tfs.map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            className={`rounded px-2 py-1 text-xs ${
              timeframe === tf ? "bg-flow-delta text-white" : "text-terminal-muted hover:bg-terminal-border"
            }`}
          >
            {tf}
          </button>
        ))}
      </div>

      <select
        value={footprintMode}
        onChange={(e) => setFootprintMode(e.target.value as FootprintMode)}
        title="Footprint cell display mode"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs"
      >
        {FOOTPRINT_MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      <select
        value={consolidation}
        onChange={(e) => setConsolidation(Number(e.target.value))}
        title="Group Ticks — consolidate price rows"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs"
      >
        {CONSOLIDATIONS.map((c) => (
          <option key={c.value} value={c.value}>
            Group {c.label}
          </option>
        ))}
      </select>

      <button
        onClick={() => setChartDisplayMode(chartDisplayMode === "footprint" ? "candle" : "footprint")}
        title="Toggle footprint / candlestick view"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs font-semibold hover:bg-terminal-border"
      >
        {chartDisplayMode === "footprint" ? "📊 Footprint" : "🕯️ Candles"}
      </button>

      <button
        onClick={toggleTheme}
        title="Toggle light / dark theme"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs font-semibold hover:bg-terminal-border"
      >
        {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
      </button>

      <button
        onClick={() => setBlockSizeModalOpen(true)}
        title="Change Orderflow Block Size (Shortcut: ;)"
        className="flex items-center gap-1 rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs font-semibold hover:bg-terminal-border"
      >
        🧱 Block: {settings.tickMultiplier}
      </button>

      <button
        onClick={() => setSettings({ lockBlockSize: !settings.lockBlockSize })}
        title={settings.lockBlockSize ? "Unlock Block Size (Enable Zoom Auto-Consolidation)" : "Lock Block Size (Disable Zoom Auto-Consolidation)"}
        className="flex items-center gap-1 rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs font-semibold hover:bg-terminal-border"
      >
        {settings.lockBlockSize ? "🔒 Locked" : "🔓 Auto"}
      </button>

      <button
        onClick={() => setFootprintSettingsOpen(true)}
        title="Footprint settings"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-sm hover:bg-terminal-border"
      >
        ⚙️
      </button>

      <button
        onClick={() => setIndicatorsOpen(true)}
        title="Custom indicators"
        className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs font-semibold italic hover:bg-terminal-border"
      >
        ƒx
      </button>

      <div className="relative flex items-center">
        <button
          onClick={() =>
            pendingAnchorTool === "anchored-vwap" ? cancelAnchorPick() : beginAnchoredVwapPlacement()
          }
          title="Anchored VWAP — click, then click a candle to drop a new anchored VWAP"
          className={`rounded-l border px-2 py-1 text-xs font-semibold ${
            pendingAnchorTool === "anchored-vwap"
              ? "border-flow-exhaustion bg-flow-exhaustion/20 text-flow-exhaustion"
              : "border-terminal-border bg-terminal-bg text-terminal-text hover:bg-terminal-border"
          }`}
        >
          AVWAP
        </button>
        <button
          onClick={() => setAvwapMgrOpen((v) => !v)}
          title="Manage Anchored VWAPs (hide / delete / clear all)"
          className={`flex items-center gap-0.5 rounded-r border border-l-0 px-1.5 py-1 text-[10px] ${
            avwapMgrOpen
              ? "border-flow-exhaustion bg-flow-exhaustion/20 text-flow-exhaustion"
              : "border-terminal-border bg-terminal-bg text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
          }`}
        >
          {avwapCount > 0 && <span className="font-semibold text-flow-exhaustion">{avwapCount}</span>}▾
        </button>
        <AvwapManager open={avwapMgrOpen} onClose={() => setAvwapMgrOpen(false)} />
      </div>

      <div className="ml-2 flex items-center gap-5">
        <Stat label="Price" value={last ? last.close.toFixed(2) : "—"} />
        <Stat label="Delta" value={`${delta >= 0 ? "+" : ""}${Math.round(delta)}`} color={delta >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"} />
        <Stat label="Cum Δ" value={`${Math.round(cum)}`} color={cum >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"} />
        <Stat label="Trend" value={last?.marketStructure ?? "—"} color="text-flow-exhaustion" />
      </div>

      <div className="ml-auto">
        <ConnectionStatus />
      </div>
    </header>
    <SettingsModal open={settingsOpen} onClose={() => setFootprintSettingsOpen(false)} />
    <IndicatorsPanel open={indicatorsOpen} onClose={() => setIndicatorsOpen(false)} />
    </>
  );
}
