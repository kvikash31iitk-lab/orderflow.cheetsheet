import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/rest";
import { useStore } from "../store/useStore";
import type {
  Sc1Candidate, Sc1Class, Sc1ComponentKey, Sc1Coverage, Sc1ExitReport,
  Sc1RunReport, Sc1Summary, Sc1SweepReport, Sc1Trade,
} from "../types/sc1research";

/* ------------------------------- helpers ------------------------------- */
const fmtIST = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });
const r2 = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const rColor = (v: number) => (v > 0.001 ? "text-flow-buyHi" : v < -0.001 ? "text-flow-sellHi" : "text-terminal-muted");

const COMPONENT_LABELS: Record<Sc1ComponentKey, string> = {
  swing: "Swing", exhaust: "Exhaustion", absorption: "Absorption", trap: "Trap", cvd: "CVD-3",
  reversal: "Reversal", reject: "Rejection", strongClose: "Strong close", lowVol: "Low vol", liqSweep: "Liq. sweep",
};
const CLASS_LABELS: Record<Sc1Class, string> = {
  baseline: "Baseline (fired)", blocked_by_candle: "Blocked by candle", near_miss: "Near miss",
};

/* ------------------------------- atoms --------------------------------- */
function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="panel flex flex-col gap-0.5 p-2.5">
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</span>
      <span className={`text-lg font-semibold ${color ?? "text-terminal-text"}`}>{value}</span>
      {sub && <span className="text-[10px] text-terminal-muted">{sub}</span>}
    </div>
  );
}
function Card({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="panel flex min-w-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border px-3 py-1.5">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-terminal-text">{title}</span>
          {subtitle && <span className="text-[10px] text-terminal-muted">{subtitle}</span>}
        </div>
        {right}
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </div>
  );
}

/* ============================== component ============================== */
const EXIT_MODEL_ORDER = ["fixed_1.5R", "fixed_2R", "trailing", "time", "opposite"];
const CLASS_ORDER: Sc1Class[] = ["baseline", "blocked_by_candle", "near_miss"];

export default function Sc1ResearchLab() {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);

  const [use5s, setUse5s] = useState(true);
  const [coverage, setCoverage] = useState<Sc1Coverage | null>(null);
  const [run, setRun] = useState<Sc1RunReport | null>(null);
  const [exits, setExits] = useState<Sc1ExitReport | null>(null);
  const [sweep, setSweep] = useState<Sc1SweepReport | null>(null);
  const [exitModel, setExitModel] = useState("fixed_2R");
  const [classFilter, setClassFilter] = useState<Sc1Class | "all">("all");
  const [selected, setSelected] = useState<Sc1Candidate | null>(null);
  const [relaxCandle, setRelaxCandle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busySweep, setBusySweep] = useState(false);
  const [error, setError] = useState("");

  const refreshCoverage = useCallback(() => {
    api.sc1Coverage(symbol).then(setCoverage).catch(() => setCoverage(null));
  }, [symbol]);

  const runAnalysis = useCallback(async () => {
    setBusy(true); setError(""); setSelected(null); setSweep(null);
    refreshCoverage();  // also refresh coverage so a stuck/failed load can be retried
    try {
      const rep = await api.sc1Run({ symbol, timeframe, use5s });
      setRun(rep);
      if (rep.ok && rep.runId) {
        setExits(await api.sc1CompareExits({ runId: rep.runId }));
      } else {
        setExits(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [symbol, timeframe, use5s, refreshCoverage]);

  // coverage on mount / symbol change; auto-run once on mount
  useEffect(() => { refreshCoverage(); }, [refreshCoverage]);
  useEffect(() => { void runAnalysis(); /* eslint-disable-next-line */ }, []);

  const runSweep = useCallback(async () => {
    setBusySweep(true); setError("");
    try {
      const grid: Record<string, number[]> = {
        i1_minStrength: [35, 40, 45, 50, 55],
        i1_netEdgeSignalThreshold: [40, 50, 60, 70],
      };
      if (relaxCandle) (grid as Record<string, (number | boolean)[]>).i1_useSignalCandleFilter = [true, false] as unknown as number[];
      setSweep(await api.sc1Sweep({ symbol, timeframe, use5s, grid, exitModel }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusySweep(false);
    }
  }, [symbol, timeframe, use5s, exitModel, relaxCandle]);

  const candById = useMemo(() => {
    const m = new Map<string, Sc1Candidate>();
    (run?.candidates ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [run]);

  const models = exits?.models ?? EXIT_MODEL_ORDER;
  const overall: Sc1Summary | undefined = exits?.overall?.[exitModel];

  const trades = useMemo(() => {
    const all = exits?.trades ?? [];
    return all
      .filter((t) => t.exit_model === exitModel)
      .filter((t) => classFilter === "all" || t.candidate_class === classFilter)
      .sort((a, b) => b.signal_time - a.signal_time);
  }, [exits, exitModel, classFilter]);

  const inv = run?.inventory;
  const totalSignals = inv ? Object.values(inv).reduce((s, v) => s + v.long + v.short, 0) : 0;

  /* candle-filter analysis: blocked row under the selected exit model */
  const blockedRow = exits?.matrix?.find((m) => m.class === "blocked_by_candle")?.cells[exitModel];
  const baselineRow = exits?.matrix?.find((m) => m.class === "baseline")?.cells[exitModel];

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto bg-terminal-bg p-4">
      {/* ----------------------------- control bar ----------------------------- */}
      <div className="panel flex flex-wrap items-center gap-3 p-3">
        <span className="text-sm font-semibold text-terminal-text">SC1 V4 Research Lab</span>
        <span className="rounded bg-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted">{symbol} · {timeframe}</span>
        <label className="flex items-center gap-1 text-xs text-terminal-muted">
          <input type="checkbox" checked={use5s} onChange={(e) => setUse5s(e.target.checked)} />
          5s orderflow
        </label>
        <button onClick={runAnalysis} disabled={busy}
          className="rounded bg-flow-buy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? "Analysing…" : "Run Analysis"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase text-terminal-muted">Exit model</span>
          <select value={exitModel} onChange={(e) => setExitModel(e.target.value)}
            className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs">
            {[...models].sort((a, b) => EXIT_MODEL_ORDER.indexOf(a) - EXIT_MODEL_ORDER.indexOf(b)).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="panel border-l-2 border-l-flow-sellHi p-2 text-xs text-flow-sellHi">{error}</div>}
      {run && !run.ok && (
        <div className="panel border-l-2 border-l-amber-500 p-2 text-xs text-amber-400">
          No data: {run.error}. Stored candles + ticks are required for this symbol/timeframe.
        </div>
      )}

      {/* honest data-scope banner */}
      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300/90">
        Harness-validation only — results use ~recent VPS data, not the 5-year GC set. Costs/slippage are
        conservative defaults (shown below), not exchange-calibrated. Use to validate the engine, not to size live risk.
      </div>

      {/* ============================ row 1: coverage + inventory ============================ */}
      <div className="grid gap-3 lg:grid-cols-2">
        {/* 1. Data Coverage */}
        <Card title="Data Coverage" subtitle="what the lab can actually see">
          {coverage ? (
            <div className="flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap gap-3">
                <div>
                  <div className="text-[10px] uppercase text-terminal-muted">Ticks</div>
                  {coverage.ticks ? (
                    <div className="font-mono">{fmtDay(coverage.ticks.minTs)} → {fmtDay(coverage.ticks.maxTs)} · {coverage.ticks.spanHours}h</div>
                  ) : <div className="text-flow-sellHi">none</div>}
                </div>
                {run?.orderflow && (
                  <div>
                    <div className="text-[10px] uppercase text-terminal-muted">5s coverage</div>
                    <div className="font-mono">{run.orderflow.used5s}/{run.orderflow.totalBars} bars{run.orderflow.source5sActive ? "" : " (parent fallback)"}</div>
                  </div>
                )}
              </div>
              <table className="w-full">
                <thead className="text-terminal-muted"><tr className="text-left">
                  <th className="py-0.5 font-medium">TF</th><th className="font-medium">Bars</th><th className="font-medium">From</th><th className="font-medium">To</th>
                </tr></thead>
                <tbody>
                  {coverage.timeframes.map((t) => (
                    <tr key={t.timeframe} className={`border-t border-terminal-border ${t.timeframe === timeframe ? "text-terminal-text" : "text-terminal-muted"}`}>
                      <td className="py-0.5 font-mono">{t.timeframe}</td>
                      <td className="font-mono">{t.count}</td>
                      <td className="font-mono">{fmtDay(t.minStart)}</td>
                      <td className="font-mono">{fmtDay(t.maxStart)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="text-xs text-terminal-muted">Loading…</div>}
        </Card>

        {/* 2. Signal Inventory */}
        <Card title="Signal Inventory" subtitle={`${totalSignals} candidates`}>
          {inv ? (
            <table className="w-full text-xs">
              <thead className="text-terminal-muted"><tr className="text-left">
                <th className="py-0.5 font-medium">Class</th><th className="text-right font-medium">Long</th>
                <th className="text-right font-medium">Short</th><th className="text-right font-medium">Total</th>
              </tr></thead>
              <tbody>
                {CLASS_ORDER.map((k) => {
                  const v = inv[k] ?? { long: 0, short: 0 };
                  return (
                    <tr key={k} className="border-t border-terminal-border">
                      <td className="py-0.5">{CLASS_LABELS[k]}</td>
                      <td className="text-right font-mono text-flow-buyHi">{v.long}</td>
                      <td className="text-right font-mono text-flow-sellHi">{v.short}</td>
                      <td className="text-right font-mono">{v.long + v.short}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="text-xs text-terminal-muted">Run analysis to populate.</div>}
        </Card>
      </div>

      {/* ============================ 3. Performance Summary ============================ */}
      <Card title="Performance Summary" subtitle={`exit = ${exitModel} · all classes`}>
        {overall ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Expectancy" value={`${overall.expectancyR >= 0 ? "+" : ""}${r2(overall.expectancyR)}R`} color={rColor(overall.expectancyR)} />
            <Stat label="Win Rate" value={pct(overall.winRate)} color={overall.winRate >= 0.5 ? "text-flow-buyHi" : "text-flow-sellHi"} />
            <Stat label="Profit Factor" value={overall.profitFactor == null ? "∞" : r2(overall.profitFactor)} color={(overall.profitFactor ?? 99) >= 1 ? "text-flow-buyHi" : "text-flow-sellHi"} />
            <Stat label="Max DD" value={`${r2(overall.maxDrawdownR)}R`} color="text-flow-sellHi" />
            <Stat label="Avg MFE" value={r2(overall.avgMfe)} color="text-flow-buyHi" sub={`med ${r2(overall.medMfe)}`} />
            <Stat label="Avg MAE" value={r2(overall.avgMae)} color="text-flow-sellHi" sub={`med ${r2(overall.medMae)}`} />
            <Stat label="Trades" value={String(overall.n)} sub={overall.n < 20 ? "thin sample" : ""} />
            <Stat label="L / S" value={`${overall.long} / ${overall.short}`} />
          </div>
        ) : <div className="text-xs text-terminal-muted">Run analysis to compute outcomes.</div>}
      </Card>

      {/* ============================ 4. Exit Comparison Matrix ============================ */}
      <Card title="Exit Comparison Matrix" subtitle="expectancy R · win% · N — per candidate class × exit model">
        {exits?.matrix ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-terminal-muted"><tr className="text-left">
                <th className="py-1 pr-2 font-medium">Class</th>
                {models.map((m) => <th key={m} className="px-2 py-1 text-center font-medium">{m}</th>)}
              </tr></thead>
              <tbody>
                {CLASS_ORDER.map((k) => {
                  const row = exits.matrix!.find((r) => r.class === k);
                  return (
                    <tr key={k} className="border-t border-terminal-border">
                      <td className="py-1 pr-2">{CLASS_LABELS[k]}</td>
                      {models.map((m) => {
                        const c = row?.cells[m];
                        if (!c || c.n === 0) return <td key={m} className="px-2 py-1 text-center text-terminal-muted">—</td>;
                        return (
                          <td key={m} className={`px-2 py-1 text-center font-mono ${m === exitModel ? "bg-terminal-border/40" : ""}`}>
                            <span className={rColor(c.expectancyR)}>{c.expectancyR >= 0 ? "+" : ""}{r2(c.expectancyR)}R</span>
                            <span className="text-terminal-muted"> · {(c.winRate * 100).toFixed(0)}% · {c.n}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="text-xs text-terminal-muted">Run analysis to compare exits.</div>}
      </Card>

      {/* ============================ 5. Candle Filter Analysis ============================ */}
      <Card title="Candle Filter Analysis" subtitle="strong signals the hard doji/hammer filter blocked">
        {inv && baselineRow ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Fired (baseline)" value={String(inv.baseline.long + inv.baseline.short)} />
              <Stat label="Blocked by candle" value={String(inv.blocked_by_candle.long + inv.blocked_by_candle.short)} color="text-amber-400" />
              <Stat label="Blocked exp." value={blockedRow && blockedRow.n ? `${blockedRow.expectancyR >= 0 ? "+" : ""}${r2(blockedRow.expectancyR)}R` : "—"} color={blockedRow ? rColor(blockedRow.expectancyR) : undefined} sub={blockedRow ? `${blockedRow.n} trades` : ""} />
              <Stat label="Fired exp." value={`${baselineRow.expectancyR >= 0 ? "+" : ""}${r2(baselineRow.expectancyR)}R`} color={rColor(baselineRow.expectancyR)} sub={`${baselineRow.n} trades`} />
            </div>
            <p className="text-[11px] leading-relaxed text-terminal-muted">
              {blockedRow && blockedRow.n > 0
                ? blockedRow.expectancyR > baselineRow.expectancyR
                  ? `Blocked signals would have averaged ${r2(blockedRow.expectancyR)}R vs the filter-passed ${r2(baselineRow.expectancyR)}R under ${exitModel} — the candle filter may be rejecting profitable setups. Confirm on the full GC set before relaxing it.`
                  : `Blocked signals averaged ${r2(blockedRow.expectancyR)}R, ≤ the filter-passed ${r2(baselineRow.expectancyR)}R — the candle filter appears to be doing its job here.`
                : "No blocked-by-candle signals in this window."}
            </p>
          </div>
        ) : <div className="text-xs text-terminal-muted">Run analysis to evaluate the candle filter.</div>}
      </Card>

      {/* ============================ 6+8. Drilldown + Attribution ============================ */}
      <div className="grid gap-3 xl:grid-cols-3">
        {/* Trade drilldown (spans 2) */}
        <div className="xl:col-span-2">
          <Card title="Trade Drilldown" subtitle={`${trades.length} trades · click a row for factor attribution`}
            right={
              <select value={classFilter} onChange={(e) => setClassFilter(e.target.value as Sc1Class | "all")}
                className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px]">
                <option value="all">all classes</option>
                {CLASS_ORDER.map((k) => <option key={k} value={k}>{CLASS_LABELS[k]}</option>)}
              </select>
            }>
            {trades.length ? (
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-terminal-panel text-terminal-muted"><tr className="text-left">
                    <th className="px-1.5 py-1 font-medium">Signal</th><th className="px-1.5 font-medium">Cls</th>
                    <th className="px-1.5 font-medium">Side</th><th className="px-1.5 font-medium">Entry@</th>
                    <th className="px-1.5 text-right font-medium">Entry</th><th className="px-1.5 text-right font-medium">Exit</th>
                    <th className="px-1.5 font-medium">Why</th><th className="px-1.5 text-right font-medium">R</th>
                    <th className="px-1.5 text-right font-medium">MAE</th><th className="px-1.5 text-right font-medium">MFE</th>
                    <th className="px-1.5 text-right font-medium">Bars</th>
                  </tr></thead>
                  <tbody>
                    {trades.slice(0, 300).map((t: Sc1Trade, i) => {
                      const sel = selected?.id === t.candidate_id;
                      return (
                        <tr key={`${t.candidate_id}-${i}`}
                          onClick={() => setSelected(candById.get(t.candidate_id) ?? null)}
                          className={`cursor-pointer border-t border-terminal-border hover:bg-terminal-border/40 ${sel ? "bg-flow-delta/15" : ""}`}>
                          <td className="whitespace-nowrap px-1.5 py-1 font-mono text-terminal-muted">{fmtIST(t.signal_time)}</td>
                          <td className="px-1.5">{t.candidate_class === "baseline" ? "B" : t.candidate_class === "blocked_by_candle" ? "Blk" : "NM"}</td>
                          <td className={`px-1.5 font-semibold ${t.side === "long" ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{t.side === "long" ? "L" : "S"}</td>
                          <td className="px-1.5 text-terminal-muted">{t.entry_source === "tick" ? "tick" : t.entry_source === "next_open" ? "open" : "close"}</td>
                          <td className="px-1.5 text-right font-mono">{r2(t.entry_price)}</td>
                          <td className="px-1.5 text-right font-mono">{r2(t.exit_price)}</td>
                          <td className="px-1.5 text-terminal-muted">{t.reason}</td>
                          <td className={`px-1.5 text-right font-mono ${rColor(t.r_multiple)}`}>{t.r_multiple >= 0 ? "+" : ""}{r2(t.r_multiple)}</td>
                          <td className="px-1.5 text-right font-mono text-flow-sellHi">{r2(t.mae)}</td>
                          <td className="px-1.5 text-right font-mono text-flow-buyHi">{r2(t.mfe)}</td>
                          <td className="px-1.5 text-right font-mono text-terminal-muted">{t.bars_held}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {trades.length > 300 && <div className="px-2 py-1 text-[10px] text-terminal-muted">Showing first 300 of {trades.length}.</div>}
              </div>
            ) : <div className="text-xs text-terminal-muted">No trades for this exit model / class.</div>}
          </Card>
        </div>

        {/* Factor attribution */}
        <Card title="Factor Attribution" subtitle={selected ? `${selected.side} @ ${fmtIST(selected.startTime)}` : "select a trade"}>
          {selected ? <Attribution c={selected} /> : <div className="text-xs text-terminal-muted">Click a trade to see which components drove its strength.</div>}
        </Card>
      </div>

      {/* ============================ 7. Optimizer Leaderboard ============================ */}
      <Card title="Optimizer Leaderboard" subtitle="bounded grid · objective = expectancy R penalised for thin samples"
        right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-terminal-muted">
              <input type="checkbox" checked={relaxCandle} onChange={(e) => setRelaxCandle(e.target.checked)} />
              ± candle filter
            </label>
            <button onClick={runSweep} disabled={busySweep}
              className="rounded bg-flow-delta px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
              {busySweep ? "Sweeping…" : "Run Sweep"}
            </button>
          </div>
        }>
        {sweep?.leaderboard?.length ? (
          <div className="max-h-[340px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-terminal-panel text-terminal-muted"><tr className="text-left">
                <th className="px-1.5 py-1 font-medium">Changed</th><th className="px-1.5 text-right font-medium">Objective</th>
                <th className="px-1.5 text-right font-medium">Exp R</th><th className="px-1.5 text-right font-medium">Win%</th>
                <th className="px-1.5 text-right font-medium">PF</th><th className="px-1.5 text-right font-medium">Max DD</th>
                <th className="px-1.5 text-right font-medium">N</th><th className="px-1.5 font-medium">Warnings</th>
              </tr></thead>
              <tbody>
                {sweep.leaderboard.map((row, i) => (
                  <tr key={i} className={`border-t border-terminal-border ${row.isBaseline ? "bg-flow-delta/10" : ""}`}>
                    <td className="px-1.5 py-1 font-mono">
                      {Object.keys(row.changed).length ? Object.entries(row.changed).map(([k, v]) => `${k.replace("i1_", "")}=${v}`).join(", ") : "(baseline)"}
                      {row.isBaseline && <span className="ml-1 rounded bg-flow-delta px-1 text-[9px] text-white">base</span>}
                    </td>
                    <td className={`px-1.5 text-right font-mono ${rColor(row.objective)}`}>{row.objective >= 0 ? "+" : ""}{r2(row.objective, 3)}</td>
                    <td className={`px-1.5 text-right font-mono ${rColor(row.expectancyR)}`}>{r2(row.expectancyR)}</td>
                    <td className="px-1.5 text-right font-mono text-terminal-muted">{(row.winRate * 100).toFixed(0)}%</td>
                    <td className="px-1.5 text-right font-mono text-terminal-muted">{row.profitFactor == null ? "∞" : r2(row.profitFactor)}</td>
                    <td className="px-1.5 text-right font-mono text-flow-sellHi">{r2(row.maxDrawdownR)}</td>
                    <td className="px-1.5 text-right font-mono">{row.n}</td>
                    <td className="px-1.5 text-[10px] text-amber-400">{row.warnings.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sweep.note && <div className="px-2 py-1.5 text-[10px] text-terminal-muted">{sweep.note}</div>}
          </div>
        ) : <div className="text-xs text-terminal-muted">Run a sweep over i1_minStrength × i1_netEdgeSignalThreshold (baseline exits, {exitModel}).</div>}
      </Card>
    </div>
  );
}

/* --------------------------- attribution panel --------------------------- */
function Attribution({ c }: { c: Sc1Candidate }) {
  const keys = Object.keys(c.weights) as Sc1ComponentKey[];
  const rows = keys
    .map((k) => ({ k, contrib: (c.components[k] ?? 0) * (c.weights[k] ?? 0), score: c.components[k] ?? 0, w: c.weights[k] ?? 0 }))
    .sort((a, b) => b.contrib - a.contrib);
  const maxContrib = Math.max(1, ...rows.map((r) => r.contrib));
  const strength = c.side === "long" ? c.bullStrength : c.bearStrength;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>Strength <b className={c.side === "long" ? "text-flow-buyHi" : "text-flow-sellHi"}>{r2(strength)}</b></span>
        <span className="text-terminal-muted">raw {r2(c.rawStrength)}</span>
        <span className="text-terminal-muted">− pen {r2(c.penalty)}</span>
        <span className="text-terminal-muted">+ bonus {r2(c.bonus)}</span>
        <span className="text-terminal-muted">net edge {r2(c.netEdge)}</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.k} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[10px] text-terminal-muted">{COMPONENT_LABELS[r.k]}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-terminal-border">
              <div className={`h-full ${c.side === "long" ? "bg-flow-buy" : "bg-flow-sell"}`} style={{ width: `${(r.contrib / maxContrib) * 100}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right font-mono text-[10px]">{r2(r.contrib, 1)} <span className="text-terminal-muted">({r.score.toFixed(2)}×{r.w})</span></span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
        {c.doji && <span className="rounded bg-terminal-border px-1.5 py-0.5">doji</span>}
        {c.hammer && <span className="rounded bg-terminal-border px-1.5 py-0.5">hammer</span>}
        {c.invHammer && <span className="rounded bg-terminal-border px-1.5 py-0.5">inv-hammer</span>}
        {c.shootingStar && <span className="rounded bg-terminal-border px-1.5 py-0.5">shooting-star</span>}
        {c.trend.adx != null && <span className="rounded bg-terminal-border px-1.5 py-0.5">ADX {r2(c.trend.adx)}</span>}
        <span className="rounded bg-terminal-border px-1.5 py-0.5">ATR {r2(c.atr)}</span>
      </div>
    </div>
  );
}
