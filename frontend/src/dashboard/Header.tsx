import { useEffect, useState } from "react";
import { Boxes, CandlestickChart, ChevronDown, Grid3x3, Lock, Moon, Settings, Sun, Unlock } from "lucide-react";
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
    <div className="flex flex-col leading-none">
      <span className="text-[9.5px] font-medium uppercase tracking-wide text-terminal-muted">{label}</span>
      <span className={`mt-0.5 font-mono text-[13px] font-semibold tabular-nums ${color ?? "text-terminal-text"}`}>{value}</span>
    </div>
  );
}

const Sep = () => <div className="mx-0.5 h-5 w-px shrink-0 bg-terminal-border" />;

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
    <header className="flex items-center gap-1.5 border-b border-terminal-border bg-terminal-panel px-3 py-1.5">
      {/* brand */}
      <div className="mr-1 flex items-baseline gap-1.5">
        <span className="text-[15px] font-bold tracking-wide text-terminal-text">VIKINGS</span>
        <span className="hidden text-[9.5px] uppercase tracking-wider text-terminal-muted lg:inline">Order Flow</span>
      </div>

      <Sep />

      {/* data source + symbol */}
      <select
        value={source}
        onChange={(e) => setSource(e.target.value as "truedata" | "databento")}
        className="tsel font-semibold"
        title="Data source"
      >
        <option value="truedata">TrueData</option>
        <option value="databento">DataBento</option>
      </select>
      <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="tsel font-semibold" title="Symbol">
        {filteredSymbols.map((s) => {
          // DataBento: mark simulated symbols (no live entitlement) without an emoji glyph
          const isSim = status?.simSymbols?.includes(s.toUpperCase()) ?? false;
          const badge = source === "databento" && isSim ? " · sim" : "";
          return (
            <option key={s} value={s}>
              {s}
              {badge}
            </option>
          );
        })}
      </select>

      <Sep />

      {/* timeframe (segmented) */}
      <div className="seg">
        {tfs.map((tf) => (
          <button key={tf} onClick={() => setTimeframe(tf)} className={`seg-item ${timeframe === tf ? "seg-item-on" : ""}`}>
            {tf}
          </button>
        ))}
      </div>

      <Sep />

      {/* footprint controls */}
      <select
        value={footprintMode}
        onChange={(e) => setFootprintMode(e.target.value as FootprintMode)}
        title="Footprint cell display mode"
        className="tsel"
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
        title="Group ticks — consolidate price rows"
        className="tsel"
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
        className="tbtn"
      >
        {chartDisplayMode === "footprint" ? <Grid3x3 size={14} className="text-terminal-muted" /> : <CandlestickChart size={14} className="text-terminal-muted" />}
        <span>{chartDisplayMode === "footprint" ? "Footprint" : "Candles"}</span>
      </button>
      <button onClick={() => setBlockSizeModalOpen(true)} title="Orderflow block size (shortcut: ;)" className="tbtn">
        <Boxes size={14} className="text-terminal-muted" />
        <span>Block {settings.tickMultiplier}</span>
      </button>
      <button
        onClick={() => setSettings({ lockBlockSize: !settings.lockBlockSize })}
        title={settings.lockBlockSize ? "Unlock block size (enable zoom auto-consolidation)" : "Lock block size (disable zoom auto-consolidation)"}
        className={`tbtn ${settings.lockBlockSize ? "tbtn-on" : ""}`}
      >
        {settings.lockBlockSize ? <Lock size={13} /> : <Unlock size={13} className="text-terminal-muted" />}
        <span>{settings.lockBlockSize ? "Locked" : "Auto"}</span>
      </button>

      <Sep />

      {/* tools */}
      <button onClick={() => setFootprintSettingsOpen(true)} title="Footprint settings" className="tbtn-icon">
        <Settings size={15} />
      </button>
      <button onClick={() => setIndicatorsOpen(true)} title="Custom indicators" className="tbtn-icon">
        <span className="text-[13px] font-semibold italic text-terminal-text">ƒx</span>
      </button>
      <div className="relative flex items-center">
        <button
          onClick={() => (pendingAnchorTool === "anchored-vwap" ? cancelAnchorPick() : beginAnchoredVwapPlacement())}
          title="Anchored VWAP — click, then click a candle to drop a new anchored VWAP"
          className={`inline-flex h-7 select-none items-center rounded-l-md border px-2.5 text-[12px] font-medium transition-colors ${
            pendingAnchorTool === "anchored-vwap"
              ? "border-flow-exhaustion/50 bg-flow-exhaustion/15 text-flow-exhaustion"
              : "border-terminal-border bg-terminal-bg/60 text-terminal-text hover:bg-terminal-border/40"
          }`}
        >
          AVWAP
        </button>
        <button
          onClick={() => setAvwapMgrOpen((v) => !v)}
          title="Manage Anchored VWAPs (hide / delete / clear all)"
          className={`inline-flex h-7 items-center gap-0.5 rounded-r-md border border-l-0 px-1.5 text-[11px] transition-colors ${
            avwapMgrOpen
              ? "border-flow-exhaustion/50 bg-flow-exhaustion/15 text-flow-exhaustion"
              : "border-terminal-border bg-terminal-bg/60 text-terminal-muted hover:bg-terminal-border/40 hover:text-terminal-text"
          }`}
        >
          {avwapCount > 0 && <span className="font-semibold text-flow-exhaustion">{avwapCount}</span>}
          <ChevronDown size={12} />
        </button>
        <AvwapManager open={avwapMgrOpen} onClose={() => setAvwapMgrOpen(false)} />
      </div>
      <button onClick={toggleTheme} title="Toggle light / dark theme" className="tbtn-icon">
        {theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
      </button>

      {/* market metrics */}
      <div className="ml-2 flex items-center gap-4">
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
