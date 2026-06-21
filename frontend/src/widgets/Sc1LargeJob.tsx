import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/rest";
import { useStore } from "../store/useStore";
import type {
  Sc1Candidate, Sc1Fold, Sc1Job, Sc1LargeResult, Sc1Summary, Sc1Trade, Sc1WalkForwardResult,
} from "../types/sc1research";

/* ------------------------------- format helpers ------------------------------- */
const fmtIST = (ms: number | null | undefined) =>
  ms == null ? "—" : new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
const fmtDay = (ms: number | null | undefined) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit" });
const r2 = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const rColor = (v: number) => (v > 0.001 ? "text-flow-buyHi" : v < -0.001 ? "text-flow-sellHi" : "text-terminal-muted");
const toMs = (d: string) => (d ? Date.parse(d + "T00:00:00Z") : null);
const toDateStr = (ms: number | null | undefined) => (ms == null ? "" : new Date(ms).toISOString().slice(0, 10));
const EXIT_MODELS = ["fixed_1.5R", "fixed_2R", "trailing", "time", "opposite"];
const SEARCH_PARAMS = ["i1_minStrength", "i1_netEdgeSignalThreshold", "i1_useSignalCandleFilter",
  "i1_dojiMaxBodyRange", "i1_hammerMinWickBody", "i1_hammerMaxOppositeWickBody"];

function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="panel flex flex-col gap-0.5 p-2.5">
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</span>
      <span className={`text-base font-semibold ${color ?? "text-terminal-text"}`}>{value}</span>
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
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[10px] uppercase text-terminal-muted">{label}</span>
      {children}
    </label>
  );
}
const inputCls = "rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs";

/* compact R-summary cell used in matrices + fold tables */
function RCell({ s, model }: { s: Sc1Summary | undefined; model?: string }) {
  if (!s || s.n === 0) return <span className="text-terminal-muted">—</span>;
  return (
    <span className="font-mono">
      <span className={rColor(s.expectancyR)}>{s.expectancyR >= 0 ? "+" : ""}{r2(s.expectancyR)}R</span>
      <span className="text-terminal-muted"> · {(s.winRate * 100).toFixed(0)}% · {s.n}</span>
    </span>
  );
}

/* ============================== component ============================== */
export default function Sc1LargeJob({ mode }: { mode: "large_run" | "walk_forward" }) {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);

  // ---- form state ----
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [use5s, setUse5s] = useState(false);
  const [minStrength, setMinStrength] = useState(45);
  const [netEdge, setNetEdge] = useState(60);
  // walk-forward
  const [windows, setWindows] = useState(4);
  const [trainFrac, setTrainFrac] = useState(0.6);
  const [valFrac, setValFrac] = useState(0.2);
  const [testFrac, setTestFrac] = useState(0.2);
  const [optMethod, setOptMethod] = useState("coordinate");
  const [optParams, setOptParams] = useState<string[]>(["i1_minStrength", "i1_netEdgeSignalThreshold"]);
  const [optBudget, setOptBudget] = useState(40);
  const [optSeed, setOptSeed] = useState(1);
  const [optExitModel, setOptExitModel] = useState("fixed_2R");

  // ---- job state ----
  const [job, setJob] = useState<Sc1Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef<number | null>(null);

  // ---- drilldown state (large_run) ----
  const [candPage, setCandPage] = useState(0);
  const [tradePage, setTradePage] = useState(0);
  const [dExitModel, setDExitModel] = useState("fixed_2R");
  const [dClass, setDClass] = useState("");
  const [dSide, setDSide] = useState("");
  const [dResult, setDResult] = useState("");
  const [cands, setCands] = useState<{ items: Sc1Candidate[]; total: number; pages: number } | null>(null);
  const [trades, setTrades] = useState<{ items: Sc1Trade[]; total: number; pages: number } | null>(null);

  const running = job != null && (job.status === "running" || job.status === "queued");
  const mounted = useRef(true);
  const activeId = useRef<string | null>(null);

  const stopPoll = () => { if (pollRef.current) { window.clearTimeout(pollRef.current); pollRef.current = null; } };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeId.current = null; stopPoll(); };
  }, []);

  // Guard against (a) re-scheduling after unmount and (b) a stale poller from a previous
  // job racing a newly-started one — only the current active job id keeps polling.
  const poll = useCallback(async (id: string) => {
    try {
      const st = await api.sc1JobStatus(id);
      if (!mounted.current || activeId.current !== id) return;
      setJob(st);
      if (st.status === "running" || st.status === "queued") {
        pollRef.current = window.setTimeout(() => poll(id), 1400);
      }
    } catch (e) {
      if (mounted.current && activeId.current === id) setError(String(e));
    }
  }, []);

  const start = useCallback(async () => {
    setBusy(true); setError(""); setCands(null); setTrades(null); stopPoll();
    try {
      const body = {
        mode, symbol, timeframe,
        start: toMs(dateFrom), end: toMs(dateTo), use5s,
        config: { i1_minStrength: minStrength, i1_netEdgeSignalThreshold: netEdge },
        walkForward: { windows, trainFrac, valFrac, testFrac },
        optimize: { method: optMethod, params: optParams, budget: optBudget, seed: optSeed, exitModel: optExitModel, minSample: 25 },
      };
      const r = await api.sc1CreateJob(body);
      if (!r.ok || !r.job) { setError(r.error || "failed to start job"); setJob(null); activeId.current = null; }
      else { activeId.current = r.job.id; setJob(r.job); poll(r.job.id); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [mode, symbol, timeframe, dateFrom, dateTo, use5s, minStrength, netEdge, windows, trainFrac, valFrac, testFrac, optMethod, optParams, optBudget, optSeed, optExitModel, poll]);

  const cancel = useCallback(async () => {
    if (job) { try { await api.sc1JobCancel(job.id); } catch { /* ignore */ } }
  }, [job]);

  // load drilldown pages when a large_run job completes or filters change
  const result = job?.result;
  const isLarge = result?.mode === "large_run";
  useEffect(() => {
    if (!job || job.status !== "done" || mode !== "large_run") return;
    api.sc1JobCandidates(job.id, { page: candPage, size: 50, klass: dClass, side: dSide })
      .then((p) => p.ok && setCands(p)).catch(() => {});
  }, [job, mode, candPage, dClass, dSide]);
  useEffect(() => {
    if (!job || job.status !== "done" || mode !== "large_run") return;
    api.sc1JobTrades(job.id, { page: tradePage, size: 50, exitModel: dExitModel, klass: dClass, side: dSide, result: dResult })
      .then((p) => p.ok && setTrades(p)).catch(() => {});
  }, [job, mode, tradePage, dExitModel, dClass, dSide, dResult]);

  const pr = job?.progress;
  const pctDone = pr && pr.total > 0 ? Math.min(100, Math.round((pr.current / pr.total) * 100)) : running ? 5 : 0;

  return (
    <div className="flex flex-col gap-3">
      {/* ----------------------------- job control ----------------------------- */}
      <Card title={mode === "walk_forward" ? "Walk-Forward Optimization — Job" : "Large Dataset Job"}
        subtitle="async background job · polls for progress · live feed stays responsive">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <span className="rounded bg-terminal-border px-2 py-1 text-[11px] text-terminal-muted">{symbol} · {timeframe}</span>
            <Field label="From (UTC)"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} /></Field>
            <Field label="To (UTC)"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} /></Field>
            <Field label="Min strength"><input type="number" value={minStrength} onChange={(e) => setMinStrength(Number(e.target.value))} className={`${inputCls} w-20`} /></Field>
            <Field label="Net edge"><input type="number" value={netEdge} onChange={(e) => setNetEdge(Number(e.target.value))} className={`${inputCls} w-20`} /></Field>
            <label className="flex items-center gap-1 text-xs text-terminal-muted"><input type="checkbox" checked={use5s} onChange={(e) => setUse5s(e.target.checked)} /> 5s (recent only)</label>
          </div>

          {mode === "walk_forward" && (
            <div className="flex flex-wrap items-end gap-3 border-t border-terminal-border pt-3">
              <Field label="Windows"><input type="number" min={1} value={windows} onChange={(e) => setWindows(Math.max(1, Number(e.target.value)))} className={`${inputCls} w-16`} /></Field>
              <Field label="Train"><input type="number" step={0.05} value={trainFrac} onChange={(e) => setTrainFrac(Number(e.target.value))} className={`${inputCls} w-16`} /></Field>
              <Field label="Val"><input type="number" step={0.05} value={valFrac} onChange={(e) => setValFrac(Number(e.target.value))} className={`${inputCls} w-16`} /></Field>
              <Field label="Test"><input type="number" step={0.05} value={testFrac} onChange={(e) => setTestFrac(Number(e.target.value))} className={`${inputCls} w-16`} /></Field>
              <Field label="Search">
                <select value={optMethod} onChange={(e) => setOptMethod(e.target.value)} className={inputCls}>
                  <option value="coordinate">coordinate</option><option value="grid">grid</option><option value="random">random</option>
                </select>
              </Field>
              <Field label="Budget"><input type="number" value={optBudget} onChange={(e) => setOptBudget(Number(e.target.value))} className={`${inputCls} w-16`} /></Field>
              <Field label="Seed"><input type="number" value={optSeed} onChange={(e) => setOptSeed(Number(e.target.value))} className={`${inputCls} w-16`} /></Field>
              <Field label="Obj. exit"><select value={optExitModel} onChange={(e) => setOptExitModel(e.target.value)} className={inputCls}>{EXIT_MODELS.map((m) => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Search space">
                <div className="flex flex-wrap gap-1">
                  {SEARCH_PARAMS.map((p) => (
                    <button key={p} type="button" onClick={() => setOptParams((s) => s.includes(p) ? s.filter((x) => x !== p) : [...s, p])}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${optParams.includes(p) ? "bg-flow-delta text-white" : "bg-terminal-border text-terminal-muted"}`}>
                      {p.replace("i1_", "")}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button onClick={start} disabled={busy || running}
              className="rounded bg-flow-buy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? "Starting…" : running ? "Running…" : mode === "walk_forward" ? "Start Walk-Forward" : "Start Large Job"}
            </button>
            {running && <button onClick={cancel} className="rounded bg-flow-sell px-3 py-1.5 text-xs font-semibold text-white">Cancel</button>}
            {job && <span className="text-[11px] text-terminal-muted">job {job.id} · {job.status}{job.elapsedSec != null ? ` · ${job.elapsedSec}s` : ""}</span>}
          </div>

          {/* progress */}
          {job && (running || job.status === "done") && (
            <div className="flex flex-col gap-1">
              <div className="h-2 overflow-hidden rounded bg-terminal-border">
                <div className={`h-full ${job.status === "done" ? "bg-flow-buy" : "bg-flow-delta"} transition-all`} style={{ width: `${job.status === "done" ? 100 : pctDone}%` }} />
              </div>
              <span className="text-[10px] text-terminal-muted">{pr?.phase} {pr && pr.total ? `(${pr.current}/${pr.total})` : ""} — {pr?.message}</span>
            </div>
          )}
          {job?.status === "failed" && <div className="text-xs text-flow-sellHi">job failed: {job.error}</div>}
          {job?.status === "cancelled" && <div className="text-xs text-amber-400">job cancelled.</div>}
        </div>
      </Card>

      {error && <div className="panel border-l-2 border-l-flow-sellHi p-2 text-xs text-flow-sellHi">{error}</div>}

      {/* data-safety banner */}
      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300/90">
        {mode === "walk_forward"
          ? "Walk-forward: parameters are chosen on TRAIN and reported on out-of-sample TEST. A config that only wins in-sample is overfit. Costs/slippage are conservative defaults; current data is recent GC, not the full 5-year set."
          : "Large job: historical bars use parent orderflow (5s only exists for the most-recent window). Costs/slippage are conservative defaults. Harness validation, not a 5-year backtest yet."}
      </div>

      {/* ----------------------------- results ----------------------------- */}
      {job?.status === "done" && isLarge && <LargeResultView res={result as Sc1LargeResult}
        cands={cands} trades={trades} candPage={candPage} setCandPage={setCandPage} tradePage={tradePage} setTradePage={setTradePage}
        dExitModel={dExitModel} setDExitModel={setDExitModel} dClass={dClass} setDClass={setDClass} dSide={dSide} setDSide={setDSide} dResult={dResult} setDResult={setDResult} />}
      {job?.status === "done" && result?.mode === "walk_forward" && <WalkForwardView res={result as Sc1WalkForwardResult} />}
    </div>
  );
}

/* ============================ large-run result ============================ */
function LargeResultView(p: any) {
  const res: Sc1LargeResult = p.res;
  const inv = res.inventory;
  const models = res.models;
  return (
    <>
      <Card title="Run Summary" subtitle={`${res.range.bars.toLocaleString()} bars · ${res.range.spanDays}d · ${res.candidateCount.toLocaleString()} candidates`}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Bars" value={res.range.bars.toLocaleString()} sub={res.range.truncated ? `capped @ ${res.range.maxBars.toLocaleString()}` : `${res.range.spanDays}d`} color={res.range.truncated ? "text-amber-400" : undefined} />
          <Stat label="Range" value={fmtDay(res.range.minStart)} sub={`→ ${fmtDay(res.range.maxStart)}`} />
          <Stat label="5s coverage" value={`${res.orderflow.totalBars ? Math.round((res.orderflow.used5s / res.orderflow.totalBars) * 100) : 0}%`} sub={res.orderflow.source5sActive ? `${res.orderflow.used5s} bars` : "parent only"} />
          <Stat label="Baseline" value={String(inv.baseline.long + inv.baseline.short)} sub={`L${inv.baseline.long}/S${inv.baseline.short}`} />
          <Stat label="Blocked" value={String(inv.blocked_by_candle.long + inv.blocked_by_candle.short)} color="text-amber-400" />
          <Stat label="Near miss" value={String(inv.near_miss.long + inv.near_miss.short)} />
        </div>
      </Card>

      <Card title="Exit Comparison Matrix" subtitle="expectancy R · win% · N — per class × exit model (over the full range)">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-terminal-muted"><tr className="text-left">
              <th className="py-1 pr-2 font-medium">Class</th>{models.map((m) => <th key={m} className="px-2 py-1 text-center font-medium">{m}</th>)}
            </tr></thead>
            <tbody>
              {res.matrix.map((row) => (
                <tr key={row.class} className="border-t border-terminal-border">
                  <td className="py-1 pr-2">{row.class}</td>
                  {models.map((m) => <td key={m} className="px-2 py-1 text-center"><RCell s={row.cells[m]} /></td>)}
                </tr>
              ))}
              <tr className="border-t border-terminal-border font-semibold">
                <td className="py-1 pr-2">overall</td>
                {models.map((m) => <td key={m} className="px-2 py-1 text-center"><RCell s={res.overall[m]} /></td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Candidate Drilldown" subtitle="bounded sample · class/side filters shared with trades">
        {p.cands?.items?.length ? (
          <>
            <div className="max-h-[260px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-terminal-panel text-terminal-muted"><tr className="text-left">
                  <th className="px-1.5 py-1 font-medium">Signal</th><th className="px-1.5 font-medium">Cls</th><th className="px-1.5 font-medium">Side</th>
                  <th className="px-1.5 text-right font-medium">Bull</th><th className="px-1.5 text-right font-medium">Bear</th>
                  <th className="px-1.5 text-right font-medium">Net edge</th><th className="px-1.5 text-right font-medium">ATR</th><th className="px-1.5 font-medium">Candle</th>
                </tr></thead>
                <tbody>
                  {p.cands.items.map((c: Sc1Candidate, i: number) => (
                    <tr key={`${c.id}-${i}`} className="border-t border-terminal-border">
                      <td className="whitespace-nowrap px-1.5 py-1 font-mono text-terminal-muted">{fmtIST(c.startTime)}</td>
                      <td className="px-1.5">{c.klass === "baseline" ? "B" : c.klass === "blocked_by_candle" ? "Blk" : "NM"}</td>
                      <td className={`px-1.5 font-semibold ${c.side === "long" ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{c.side === "long" ? "L" : "S"}</td>
                      <td className="px-1.5 text-right font-mono text-flow-buyHi">{r2(c.bullStrength)}</td>
                      <td className="px-1.5 text-right font-mono text-flow-sellHi">{r2(c.bearStrength)}</td>
                      <td className="px-1.5 text-right font-mono">{r2(c.netEdge)}</td>
                      <td className="px-1.5 text-right font-mono text-terminal-muted">{r2(c.atr)}</td>
                      <td className="px-1.5 text-[10px] text-terminal-muted">{[c.doji && "doji", c.hammer && "ham", c.invHammer && "inv", c.shootingStar && "ss"].filter(Boolean).join(" ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={p.candPage} pages={p.cands.pages} total={p.cands.total} onPage={p.setCandPage} />
          </>
        ) : <div className="text-xs text-terminal-muted">No candidates for this filter.</div>}
      </Card>

      <Card title="Trade Drilldown" subtitle={`bounded sample of ${res.drilldownSample.toLocaleString()} most-recent candidates · paginated`}
        right={
          <div className="flex flex-wrap gap-1.5">
            <select value={p.dExitModel} onChange={(e) => { p.setDExitModel(e.target.value); p.setTradePage(0); }} className={inputCls}>{EXIT_MODELS.map((m) => <option key={m}>{m}</option>)}</select>
            <select value={p.dClass} onChange={(e) => { p.setDClass(e.target.value); p.setTradePage(0); p.setCandPage(0); }} className={inputCls}><option value="">all classes</option><option value="baseline">baseline</option><option value="blocked_by_candle">blocked</option><option value="near_miss">near_miss</option></select>
            <select value={p.dSide} onChange={(e) => { p.setDSide(e.target.value); p.setTradePage(0); p.setCandPage(0); }} className={inputCls}><option value="">L/S</option><option value="long">long</option><option value="short">short</option></select>
            <select value={p.dResult} onChange={(e) => { p.setDResult(e.target.value); p.setTradePage(0); }} className={inputCls}><option value="">win/loss</option><option value="win">win</option><option value="loss">loss</option></select>
          </div>
        }>
        {p.trades?.items?.length ? (
          <>
            <div className="max-h-[340px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-terminal-panel text-terminal-muted"><tr className="text-left">
                  <th className="px-1.5 py-1 font-medium">Signal</th><th className="px-1.5 font-medium">Cls</th><th className="px-1.5 font-medium">Side</th>
                  <th className="px-1.5 text-right font-medium">Entry</th><th className="px-1.5 text-right font-medium">Exit</th><th className="px-1.5 font-medium">Why</th>
                  <th className="px-1.5 text-right font-medium">R</th><th className="px-1.5 text-right font-medium">Bars</th>
                </tr></thead>
                <tbody>
                  {p.trades.items.map((t: Sc1Trade, i: number) => (
                    <tr key={`${t.candidate_id}-${i}`} className="border-t border-terminal-border">
                      <td className="whitespace-nowrap px-1.5 py-1 font-mono text-terminal-muted">{fmtIST(t.signal_time)}</td>
                      <td className="px-1.5">{t.candidate_class === "baseline" ? "B" : t.candidate_class === "blocked_by_candle" ? "Blk" : "NM"}</td>
                      <td className={`px-1.5 font-semibold ${t.side === "long" ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{t.side === "long" ? "L" : "S"}</td>
                      <td className="px-1.5 text-right font-mono">{r2(t.entry_price)}</td>
                      <td className="px-1.5 text-right font-mono">{r2(t.exit_price)}</td>
                      <td className="px-1.5 text-terminal-muted">{t.reason}</td>
                      <td className={`px-1.5 text-right font-mono ${rColor(t.r_multiple)}`}>{t.r_multiple >= 0 ? "+" : ""}{r2(t.r_multiple)}</td>
                      <td className="px-1.5 text-right font-mono text-terminal-muted">{t.bars_held}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={p.tradePage} pages={p.trades.pages} total={p.trades.total} onPage={p.setTradePage} />
          </>
        ) : <div className="text-xs text-terminal-muted">No trades for this filter.</div>}
      </Card>
    </>
  );
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (n: number) => void }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-terminal-muted">
      <button disabled={page <= 0} onClick={() => onPage(page - 1)} className="rounded bg-terminal-border px-2 py-0.5 disabled:opacity-40">‹ Prev</button>
      <span>page {page + 1} / {Math.max(1, pages)} · {total.toLocaleString()} rows</span>
      <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className="rounded bg-terminal-border px-2 py-0.5 disabled:opacity-40">Next ›</button>
    </div>
  );
}

/* ============================ walk-forward result ============================ */
function WalkForwardView({ res }: { res: Sc1WalkForwardResult }) {
  const s = res.stability;
  return (
    <>
      <Card title="Walk-Forward Summary" subtitle={`${res.search.method} search · ${res.search.configsEvaluated} configs · obj ${res.exitModel} · ${res.range.bars.toLocaleString()} bars`}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Folds" value={String(s.folds)} sub={res.range.truncated ? `capped @ ${res.range.maxBars.toLocaleString()}` : `${res.range.spanDays}d`} color={res.range.truncated ? "text-amber-400" : undefined} />
          <Stat label="Mean test R" value={`${s.meanTestExpectancyR >= 0 ? "+" : ""}${r2(s.meanTestExpectancyR)}`} color={rColor(s.meanTestExpectancyR)} sub={`±${r2(s.stdTestExpectancyR)} σ`} />
          <Stat label="Test +ve folds" value={`${s.testPositiveFolds}/${s.folds}`} color={s.testPositiveFolds > s.folds / 2 ? "text-flow-buyHi" : "text-flow-sellHi"} />
          <Stat label="Beats baseline OOS" value={`${s.selectedBeatsBaselineOOS}/${s.folds}`} color={s.selectedBeatsBaselineOOS > s.folds / 2 ? "text-flow-buyHi" : "text-flow-sellHi"} />
          <Stat label="Search space" value={String(res.search.params.length)} sub={res.search.params.map((x) => x.replace("i1_", "")).join(", ")} />
          <Stat label="Seed" value={String(res.search.seed)} />
        </div>
        {res.warnings.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {res.warnings.map((w, i) => <div key={i} className="text-[11px] text-amber-400">⚠ {w}</div>)}
          </div>
        )}
      </Card>

      <Card title="Walk-Forward Folds" subtitle="optimize on train → report on test · degradation & overfit flagged per fold">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-terminal-muted"><tr className="text-left">
              <th className="px-1.5 py-1 font-medium">#</th><th className="px-1.5 font-medium">Test window</th>
              <th className="px-1.5 font-medium">Selected change</th>
              <th className="px-1.5 text-center font-medium">Train R</th><th className="px-1.5 text-center font-medium">Val R</th><th className="px-1.5 text-center font-medium">Test R</th>
              <th className="px-1.5 text-right font-medium">Degr</th><th className="px-1.5 text-center font-medium">vs base OOS</th><th className="px-1.5 font-medium">Flags</th>
            </tr></thead>
            <tbody>
              {res.folds.map((f: Sc1Fold) => {
                const ch = Object.entries(f.selected.changed).map(([k, v]) => `${k.replace("i1_", "")}=${v}`).join(", ") || "(baseline)";
                return (
                  <tr key={f.window} className="border-t border-terminal-border align-top">
                    <td className="px-1.5 py-1 font-mono">{f.window}</td>
                    <td className="px-1.5 font-mono text-terminal-muted">{fmtDay(f.windowMeta.test.startTime)}→{fmtDay(f.windowMeta.test.endTime)}</td>
                    <td className="px-1.5 font-mono">{ch}</td>
                    <td className="px-1.5 text-center"><RCell s={f.selected.train} /></td>
                    <td className="px-1.5 text-center"><RCell s={f.selected.val} /></td>
                    <td className="px-1.5 text-center"><RCell s={f.selected.test} /></td>
                    <td className={`px-1.5 text-right font-mono ${rColor(f.selected.trainToTestDegradationR)}`}>{r2(f.selected.trainToTestDegradationR)}</td>
                    <td className={`px-1.5 text-center font-semibold ${f.selectedBeatsBaselineOOS ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{f.selectedBeatsBaselineOOS ? "win" : "lose"}</td>
                    <td className="px-1.5 text-[10px] text-amber-400">{f.selected.overfit ? "overfit " : ""}{f.warnings.join("; ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-terminal-muted">{res.note}</p>
      </Card>

      <Card title="Parameter Stability" subtitle="does the selected parameter stay the same across folds? drift = low confidence">
        {Object.keys(res.stability.paramStability).length ? (
          <table className="w-full text-xs">
            <thead className="text-terminal-muted"><tr className="text-left"><th className="py-1 pr-2 font-medium">Param</th><th className="font-medium">Selected per fold</th><th className="text-right font-medium">Distinct</th><th className="text-center font-medium">Stable</th></tr></thead>
            <tbody>
              {Object.entries(res.stability.paramStability).map(([k, v]) => (
                <tr key={k} className="border-t border-terminal-border">
                  <td className="py-1 pr-2 font-mono">{k.replace("i1_", "")}</td>
                  <td className="font-mono text-terminal-muted">{v.values.map(String).join(", ")}</td>
                  <td className="text-right font-mono">{v.distinct}</td>
                  <td className={`text-center font-semibold ${v.stable ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{v.stable ? "yes" : "drift"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-xs text-terminal-muted">Baseline selected in every fold (no parameter changes chosen).</div>}
      </Card>
    </>
  );
}
