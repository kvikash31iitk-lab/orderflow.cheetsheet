import { useStore } from "../store/useStore";

const SIG_COLOR: Record<string, string> = {
  ABSORPTION: "text-flow-absorption",
  EXHAUSTION: "text-flow-exhaustion",
  LP: "text-flow-lpSupport",
  AD: "text-flow-ad",
  STACKED_IMBALANCE: "text-flow-delta",
  DELTA_SPIKE: "text-flow-buyHi",
  VOLUME_SPIKE: "text-flow-buyHi",
  HVN: "text-terminal-muted",
  LVN: "text-terminal-muted",
};

const DATABENTO_SYMBOLS = ["6E.V.0", "GC.V.0", "6E.v.0", "GC.v.0"];

export default function Scanner() {
  const rows = useStore((s) => s.scanner);
  const source = useStore((s) => s.source);
  const selectChartContext = useStore((s) => s.selectChartContext);

  const filteredRows = rows.filter((r) => {
    const isDb = DATABENTO_SYMBOLS.includes(r.symbol.toUpperCase());
    return source === "databento" ? isDb : !isDb;
  });

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 border-b border-terminal-border-strong bg-terminal-panel text-terminal-muted">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">Symbol</th>
            <th className="px-2 py-1 font-medium text-right">Δ</th>
            <th className="px-2 py-1 font-medium text-right">CumΔ</th>
            <th className="px-2 py-1 font-medium">Trend</th>
            <th className="px-2 py-1 font-medium">Signals</th>
          </tr>
        </thead>
        <tbody>
          {filteredRows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-2 py-4 text-center text-terminal-muted">
                waiting for closed candles…
              </td>
            </tr>
          )}
          {filteredRows.map((r) => (
            <tr
              key={`${r.symbol}_${r.timeframe}`}
              onClick={() => selectChartContext(r.symbol, r.timeframe)}
              className="cursor-pointer border-t border-terminal-border hover:bg-terminal-elevated"
            >
              <td className="px-2 py-1 font-semibold">
                {r.symbol} <span className="text-[10.5px] font-normal text-terminal-muted">({r.timeframe})</span>
              </td>
              <td className={`px-2 py-1 text-right ${r.delta >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                {r.delta >= 0 ? "+" : ""}
                {Math.round(r.delta)}
              </td>
              <td className={`px-2 py-1 text-right ${r.cumDelta >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                {Math.round(r.cumDelta)}
              </td>
              <td className="px-2 py-1 text-terminal-muted">{r.trend ?? "—"}</td>
              <td className="px-2 py-1">
                <div className="flex flex-wrap gap-1">
                  {r.signals.map((s) => (
                    <span
                      key={s}
                      className={`${SIG_COLOR[s] ?? "text-terminal-text"} rounded border border-terminal-border bg-terminal-elevated px-1 py-0.5 text-[10.5px] font-medium`}
                    >
                      {s.replace("_", " ")}
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
