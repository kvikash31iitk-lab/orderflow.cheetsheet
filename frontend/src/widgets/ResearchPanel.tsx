import { useState } from "react";
import { api } from "../api/rest";
import { useStore } from "../store/useStore";
import type { ResearchReport } from "../types/orderflow";

type Mode = "single" | "sweep";
type Kind = "AD" | "LP" | "ABSORPTION" | "EXHAUSTION";

/** Format epoch-ms as IST (Asia/Kolkata), e.g. "09 Jun 09:15" */
const fmtIST = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

// Tunable engine thresholds (Settings field names) exposed per signal kind.
// `single` = one value (re-runs the engine with that threshold); `sweep` = a
// comma-separated candidate list for the parameter grid.
type Field = { key: string; label: string; single: string; sweep: string };
const PARAM_FIELDS: Record<Kind, Field[]> = {
  AD: [{ key: "ad_delta_percentile", label: "Δ percentile", single: "90", sweep: "85,90,95" }],
  LP: [
    { key: "lp_volume_std", label: "Volume σ", single: "2", sweep: "1.5,2,2.5" },
    { key: "lp_max_body_fraction", label: "Max body frac", single: "0.3", sweep: "0.2,0.3,0.4" },
  ],
  ABSORPTION: [{ key: "absorption_volume_std", label: "Volume σ", single: "2", sweep: "1.5,2,2.5" }],
  EXHAUSTION: [{ key: "exhaustion_volume_fraction", label: "Volume frac", single: "0.35", sweep: "0.25,0.35,0.45" }],
};

const KINDS: Kind[] = ["AD", "LP", "ABSORPTION", "EXHAUSTION"];

function Score({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="panel flex flex-col gap-1 p-3">
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</span>
      <span className={`text-xl font-semibold ${color ?? ""}`}>{value}</span>
    </div>
  );
}

export default function ResearchPanel() {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);

  const [mode, setMode] = useState<Mode>("single");
  const [kind, setKind] = useState<Kind>("AD");
  const [horizon, setHorizon] = useState(5);
  const [params, setParams] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [sweep, setSweep] = useState<ResearchReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [synced, setSynced] = useState<number | null>(null);

  const fields = PARAM_FIELDS[kind];
  // a blank/whitespace input falls back to the mode-appropriate default
  const paramVal = (f: Field) => {
    const v = params[f.key];
    if (v != null && v.trim() !== "") return v;
    return mode === "single" ? f.single : f.sweep;
  };
  const toNums = (s: string) =>
    s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

  const runSingle = async () => {
    setBusy(true);
    setError("");
    setSweep([]);
    try {
      // single threshold per field -> re-run the engine with those settings
      const p: Record<string, number> = {};
      for (const f of fields) {
        const n = toNums(paramVal(f))[0];
        if (Number.isFinite(n)) p[f.key] = n;
      }
      setReport(await api.researchValidate({ symbol, timeframe, kind, horizon, limit: 3000, params: p }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runSweep = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const grid: Record<string, number[]> = {};
      for (const f of fields) {
        const vals = toNums(paramVal(f));
        if (vals.length) grid[f.key] = vals;
      }
      const r = await api.researchSweep({ symbol, timeframe, kind, horizon, limit: 3000, grid });
      setSweep(r.reports);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.researchSync(horizon);
      setSynced(r.updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // copy a sweep row's parameters back into the inputs ("apply the settings")
  const applyRow = (label: string) => {
    const next: Record<string, string> = { ...params };
    for (const part of label.split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k && v !== undefined) next[k] = v;
    }
    setParams(next);
    setMode("single");
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto bg-terminal-bg p-4">
      {/* controls */}
      <div className="panel flex flex-wrap items-end gap-4 p-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-terminal-muted">Backtest</span>
          <div className="flex gap-0.5">
            {(["single", "sweep"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-1 text-xs ${mode === m ? "bg-flow-delta text-white" : "bg-terminal-border text-terminal-muted"}`}
              >
                {m === "single" ? "Single" : "Parameter Sweep"}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[10px] uppercase text-terminal-muted">Signal</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="rounded border border-terminal-border bg-terminal-bg px-2 py-1"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[10px] uppercase text-terminal-muted">Horizon (bars)</span>
          <input
            type="number"
            min={1}
            value={horizon}
            onChange={(e) => setHorizon(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 rounded border border-terminal-border bg-terminal-bg px-2 py-1"
          />
        </label>

        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="text-[10px] uppercase text-terminal-muted">{f.label}</span>
            <input
              value={params[f.key] ?? (mode === "single" ? f.single : f.sweep)}
              onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
              placeholder={mode === "single" ? f.single : f.sweep}
              title={mode === "single" ? "threshold value" : "comma-separated candidate values"}
              className="w-28 rounded border border-terminal-border bg-terminal-bg px-2 py-1"
            />
          </label>
        ))}

        <button
          onClick={mode === "single" ? runSingle : runSweep}
          disabled={busy}
          className="rounded bg-flow-buy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Running…" : mode === "single" ? "Run Backtest" : "Run Sweep"}
        </button>

        <button
          onClick={sync}
          disabled={busy}
          title="Compute MAE/MFE outcomes for stored signals"
          className="rounded bg-terminal-border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Sync Outcomes{synced !== null ? ` (${synced})` : ""}
        </button>

        <span className="text-xs text-terminal-muted">
          {symbol} · {timeframe}
        </span>
      </div>

      {error && <div className="panel border-l-2 border-l-flow-sellHi p-2 text-xs text-flow-sellHi">{error}</div>}

      {/* single-mode scorecard */}
      {mode === "single" && report && (
        <div>
          <div className="mb-2 text-xs text-terminal-muted">
            {report.label} · sample size N = {report.n}
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <Score label="Win Rate" value={`${(report.winRate * 100).toFixed(1)}%`} color={report.winRate >= 0.5 ? "text-flow-buyHi" : "text-flow-sellHi"} />
            <Score label="Expectancy" value={report.expectancy.toFixed(3)} color={report.expectancy >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"} />
            <Score label="Avg MAE" value={report.avgMae.toFixed(3)} color="text-flow-sellHi" />
            <Score label="Avg MFE" value={report.avgMfe.toFixed(3)} color="text-flow-buyHi" />
            <Score label="Samples (N)" value={String(report.n)} />
          </div>
          {report.n === 0 && (
            <div className="mt-2 text-xs text-terminal-muted">
              No {kind} signals found in the loaded window for {symbol} {timeframe}.
            </div>
          )}

          {/* individual trades / signal outcomes */}
          <div className="mt-4">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-terminal-text">
              Individual Trades / Signal Outcomes
            </div>
            {report.outcomes && report.outcomes.length > 0 ? (
              <div className="panel overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-terminal-panel text-terminal-muted">
                    <tr className="text-left">
                      <th className="px-2 py-1 font-medium">Time</th>
                      <th className="px-2 py-1 font-medium">Side</th>
                      <th className="px-2 py-1 text-right font-medium">Entry</th>
                      <th className="px-2 py-1 text-right font-medium">Exit Price</th>
                      <th className="px-2 py-1 font-medium">Exit Time</th>
                      <th className="px-2 py-1 text-right font-medium">MAE</th>
                      <th className="px-2 py-1 text-right font-medium">MFE</th>
                      <th className="px-2 py-1 text-right font-medium">Return</th>
                      <th className="px-2 py-1 text-center font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.outcomes.map((o, i) => (
                      <tr key={`${o.startTime}-${i}`} className="border-t border-terminal-border hover:bg-terminal-border/40">
                        <td className="whitespace-nowrap px-2 py-1 font-mono text-terminal-muted">
                          {fmtIST(o.startTime)}
                        </td>
                        <td className={`px-2 py-1 font-semibold ${o.side === "long" ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                          {o.side === "long" ? "LONG" : "SHORT"}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">{o.entry.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right font-mono">{o.exitPrice.toFixed(2)}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono text-terminal-muted">
                          {fmtIST(o.endTime)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-flow-sellHi">{o.mae.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right font-mono text-flow-buyHi">{o.mfe.toFixed(2)}</td>
                        <td className={`px-2 py-1 text-right font-mono ${o.ret >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                          {o.ret >= 0 ? "+" : ""}
                          {o.ret.toFixed(2)}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${o.win ? "bg-flow-buy/20 text-flow-buyHi" : "bg-flow-sell/20 text-flow-sellHi"}`}>
                            {o.win ? "WIN" : "LOSS"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel p-3 text-xs text-terminal-muted">
                No individual trades to display (N = 0).
              </div>
            )}
          </div>
        </div>
      )}

      {/* sweep-mode table */}
      {mode === "sweep" && sweep.length > 0 && (
        <div className="panel min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-terminal-panel text-terminal-muted">
              <tr className="text-left">
                <th className="px-2 py-1 font-medium">Parameters</th>
                <th className="px-2 py-1 text-right font-medium">Win %</th>
                <th className="px-2 py-1 text-right font-medium">Expectancy</th>
                <th className="px-2 py-1 text-right font-medium">Avg MAE</th>
                <th className="px-2 py-1 text-right font-medium">Avg MFE</th>
                <th className="px-2 py-1 text-right font-medium">N</th>
                <th className="px-2 py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {[...sweep].sort((a, b) => b.expectancy - a.expectancy).map((r, i) => (
                <tr key={`${r.label}-${i}`} className="border-t border-terminal-border hover:bg-terminal-border/40">
                  <td className="px-2 py-1 font-mono">{r.label || "(defaults)"}</td>
                  <td className={`px-2 py-1 text-right ${r.winRate >= 0.5 ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                    {(r.winRate * 100).toFixed(0)}%
                  </td>
                  <td className={`px-2 py-1 text-right ${r.expectancy >= 0 ? "text-flow-buyHi" : "text-flow-sellHi"}`}>
                    {r.expectancy.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-right text-flow-sellHi">{r.avgMae.toFixed(3)}</td>
                  <td className="px-2 py-1 text-right text-flow-buyHi">{r.avgMfe.toFixed(3)}</td>
                  <td className="px-2 py-1 text-right text-terminal-muted">{r.n}</td>
                  <td className="px-2 py-1">
                    <button onClick={() => applyRow(r.label)} className="rounded bg-terminal-border px-2 py-0.5 hover:bg-flow-delta hover:text-white">
                      Apply
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
