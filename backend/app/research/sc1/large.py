"""Large-dataset SC1 research: date-range "large run" + walk-forward optimisation, run as
background JOBS (see jobs.py) on one worker thread.

Why jobs (not the synchronous /run): a 5-year range is hundreds of thousands of bars — an
engine pass is tens of seconds and an optimisation is minutes, far past any HTTP/nginx
timeout. The async layer LOADS the data, then hands pure data to the worker thread; the
event loop / live WS+footprint feed is never blocked. Jobs keep small SUMMARIES + a BOUNDED
drilldown sample (not every candidate/trade), so memory is bounded regardless of range.
Historical bars use parent orderflow (5s only exists for the recent window); use_5s is
best-effort and bounded by MAX_RESEARCH_TICKS.
"""
from __future__ import annotations

import asyncio
import statistics as _st
from typing import Optional

from ...market_data.aggregator import default_row_size
from ...market_data.seconds_aggregator import aggregate_ticks_to_candles
from . import datasets as _ds
from . import optimizer as _opt
from .config import ExitConfig, Sc1Config
from .engine import run_engine
from .exits import evaluate_candidate
from .jobs import MANAGER, Job
from .service import (MAX_RESEARCH_TICKS, _lite, _opposite_times, _resolve_entries,
                      _scrub, _summarize)

MAX_JOB_BARS = 250_000      # one engine pass cap (memory-bounded on the shared single worker)
DRILLDOWN_CAP = 5_000       # retained candidates per job for paging
TRADE_CAP = 30_000          # explicit hard ceiling on retained trade rows (candidates x models)


# ------------------------------------------------------------- data + eval helpers
def _build_5s(ticks, symbol, base):
    """Pure-Python tick materialisation + 5s aggregation. Runs OFF the event loop (up to
    700k ticks) so the live WS/footprint feed isn't stalled at job start."""
    tick_ts = [int(t["ts"]) for t in ticks]
    tick_px = [float(t["price"]) for t in ticks]
    cs = aggregate_ticks_to_candles(ticks, symbol, "5s", 5000, base)
    five_s = [{"startTime": c.start_time, "totalAskVolume": c.total_ask_volume,
               "totalBidVolume": c.total_bid_volume, "delta": c.delta} for c in cs]
    return tick_ts, tick_px, five_s


async def _load_range(pg, symbol, timeframe, start_ms, end_ms, use_5s):
    base = default_row_size(symbol)
    mm = await pg.footprints_minmax(symbol, timeframe, row_size=base)
    if not mm:
        return [], None, [], [], False, False, start_ms, end_ms
    lo = mm["minStart"] if start_ms is None else max(int(start_ms), mm["minStart"])
    hi = mm["maxStart"] if end_ms is None else min(int(end_ms), mm["maxStart"])
    # footprints_range returns the MOST-RECENT bars in range (ascending), dicts built off-loop
    rows = await pg.footprints_range(symbol, timeframe, lo, hi, row_size=base, limit=MAX_JOB_BARS + 1)
    truncated = len(rows) > MAX_JOB_BARS
    rows = rows[-MAX_JOB_BARS:]   # keep the most-recent MAX_JOB_BARS (not the oldest)
    five_s = None
    tick_ts: list[int] = []
    tick_px: list[float] = []
    used5s = False
    if rows and use_5s:
        # Historical Parquet providers (windowed_ticks) fetch ticks BOUNDED to the analysis
        # window [first bar start, last bar end] — otherwise an old window's most-recent-N tick
        # cap would pull ticks from the dataset END (e.g. 2026) instead of the requested period.
        # Live Postgres has no such attr -> unchanged recent_ticks path (data ends ~now anyway).
        if getattr(pg, "windowed_ticks", False):
            hi_tick = max(int(r.get("endTime") or r["startTime"]) for r in rows)
            ticks = await pg.ticks_range(symbol, rows[0]["startTime"], hi_tick, limit=MAX_RESEARCH_TICKS)
        else:
            ticks = await pg.recent_ticks(symbol, rows[0]["startTime"], limit=MAX_RESEARCH_TICKS)
        if ticks:
            tick_ts, tick_px, five_s = await asyncio.to_thread(_build_5s, ticks, symbol, base)
            used5s = len(five_s) > 0
    return rows, five_s, tick_ts, tick_px, used5s, truncated, lo, hi


def _eval_lite(rows, candidates, exit_cfg, model: Optional[str] = None) -> list[dict]:
    """Candidates -> list of `_lite` scalar dicts (optionally one exit model). Holds only
    scalars, never the full TradeOutcome objects, so it scales to large candidate sets."""
    opp = _opposite_times(candidates)
    out: list[dict] = []
    for cand in candidates:
        for o in evaluate_candidate(cand, rows, cand["entry"], cand["entryTime"],
                                    cand["entrySource"], opp[cand["side"]], exit_cfg):
            if model is None or o.exit_model == model:
                out.append(_lite(o))
    return out


def _matrix_from_lite(lite: list[dict], models: list[str]):
    klasses = ["baseline", "blocked_by_candle", "near_miss"]
    matrix = [{"class": kl,
               "cells": {m: _summarize([it for it in lite if it["klass"] == kl and it["model"] == m]) for m in models}}
              for kl in klasses]
    overall = {m: _summarize([it for it in lite if it["model"] == m]) for m in models}
    return matrix, overall


def _bounded_drilldown(rows, candidates, exit_cfg):
    cs = sorted(candidates, key=lambda c: c["startTime"])[-DRILLDOWN_CAP:]
    keep = {c["id"] for c in cs}
    opp = _opposite_times(candidates)
    trades = []
    for cand in candidates:
        if cand["id"] not in keep:
            continue
        for o in evaluate_candidate(cand, rows, cand["entry"], cand["entryTime"],
                                    cand["entrySource"], opp[cand["side"]], exit_cfg):
            trades.append(o.to_dict())
    return _scrub([dict(c) for c in cs]), _scrub(trades[:TRADE_CAP])


# ----------------------------------------------------------------- large run worker
def _large_run_worker(job: Job, rows, five_s, tick_ts, tick_px, cfg: Sc1Config, exit_cfg: ExitConfig,
                      symbol, timeframe, used5s, truncated, lo, hi):
    job.set_progress(phase="engine", current=0, total=4, message=f"engine over {len(rows)} bars")
    res = run_engine(rows, cfg, five_s, collect_bars=False)
    cands = res["candidates"]
    _resolve_entries(rows, cands, tick_ts, tick_px)
    job.check_cancel()
    job.set_progress(phase="exits", current=1, total=4, message=f"scoring {len(cands)} candidates")
    lite = _eval_lite(rows, cands, exit_cfg)
    job.check_cancel()
    job.set_progress(phase="summarize", current=2, total=4, message="summarising")
    inv = {"baseline": {"long": 0, "short": 0}, "blocked_by_candle": {"long": 0, "short": 0}, "near_miss": {"long": 0, "short": 0}}
    for c in cands:
        inv.setdefault(c["klass"], {"long": 0, "short": 0})[c["side"]] += 1
    models = sorted({it["model"] for it in lite})
    matrix, overall = _matrix_from_lite(lite, models)
    job.check_cancel()
    job.set_progress(phase="drilldown", current=3, total=4, message="building drilldown sample")
    drill_c, drill_t = _bounded_drilldown(rows, cands, exit_cfg)
    job.drilldown = {"candidates": drill_c, "trades": drill_t}
    span_days = round((rows[-1]["startTime"] - rows[0]["startTime"]) / 86_400_000, 1)
    job.result = _scrub({
        "mode": "large_run", "symbol": symbol, "timeframe": timeframe,
        "config": cfg.to_dict(), "exitConfig": exit_cfg.to_dict(),
        "range": {"minStart": rows[0]["startTime"], "maxStart": rows[-1]["startTime"], "bars": len(rows),
                  "requestedFrom": lo, "requestedTo": hi, "spanDays": span_days,
                  "truncated": truncated, "maxBars": MAX_JOB_BARS},
        "orderflow": {"used5s": res["used5s"], "totalBars": res["n"], "source5sActive": used5s},
        "inventory": inv, "candidateCount": len(cands),
        "models": models, "matrix": matrix, "overall": overall, "drilldownSample": len(drill_c),
    })
    job.set_progress(phase="done", current=4, total=4, message="complete")


# ------------------------------------------------------------- walk-forward worker
def _win_summary(lite_model, lo_t, hi_t, embargo_ms=0):
    # embargo: drop signals within `embargo_ms` of the segment end so a train/val outcome
    # whose holding window extends into the NEXT segment can't leak future info into selection.
    cut = hi_t - embargo_ms
    return _summarize([it for it in lite_model if lo_t <= it["sig"] < cut])


def _walkforward_worker(job: Job, rows, five_s, tick_ts, tick_px, base_cfg: Sc1Config, exit_cfg: ExitConfig,
                        symbol, timeframe, used5s, truncated, lo, hi, wf: dict, opt: dict):
    n = len(rows)
    windows = _ds.make_windows(n, windows=wf["windows"], train_frac=wf["trainFrac"],
                               val_frac=wf["valFrac"], test_frac=wf["testFrac"])
    t_of = lambda i: int(rows[i]["startTime"])
    win_meta = [w.to_dict(t_of) for w in windows]
    exit_model = opt.get("exitModel", "fixed_2R")
    space = _opt.select_space(opt.get("params"))
    configs = _opt.generate(space, method=opt.get("method", "coordinate"),
                            budget=opt.get("budget", _opt.MAX_EVALS), seed=opt.get("seed", 1))
    total = len(configs)
    min_sample = opt.get("minSample", 25)
    bar_ms = (rows[1]["startTime"] - rows[0]["startTime"]) if n > 1 else 60000
    embargo_ms = max(0, int(exit_cfg.max_hold_bars)) * bar_ms  # purge train/val tail signals

    per_config = []
    for ci, changed in enumerate(configs):
        job.check_cancel()
        job.set_progress(phase="optimize", current=ci, total=total,
                         message=f"config {ci + 1}/{total}")
        cfg = base_cfg.clone(**changed)
        res = run_engine(rows, cfg, five_s, collect_bars=False)
        _resolve_entries(rows, res["candidates"], tick_ts, tick_px)
        lite_m = _eval_lite(rows, res["candidates"], exit_cfg, model=exit_model)
        wrows = []
        for w in windows:
            tr = _win_summary(lite_m, t_of(w.train[0]), t_of(w.train[1] - 1) + 1, embargo_ms)
            va = _win_summary(lite_m, t_of(w.val[0]), t_of(w.val[1] - 1) + 1, embargo_ms)
            te = _win_summary(lite_m, t_of(w.test[0]), t_of(w.test[1] - 1) + 1)  # test: no embargo (OOS report)
            trscore = _opt.objective(tr, changed, min_sample)["score"]
            wrows.append({"train": tr, "val": va, "test": te, "trainScore": trscore})
        per_config.append({"changed": changed, "configHash": cfg.config_hash(),
                           "isBaseline": len(changed) == 0, "windows": wrows})
        del lite_m

    baseline = next((c for c in per_config if c["isBaseline"]), per_config[0])
    fold_rows = []
    test_exp = []
    selected_params: dict = {}
    for w in windows:
        idx = w.index
        # only let configs with a credible TRAIN sample win selection (avoid noise winners);
        # fall back to the full set if none qualify.
        pool = [c for c in per_config if c["windows"][idx]["train"]["n"] >= min_sample] or per_config
        sel = max(pool, key=lambda c: c["windows"][idx]["trainScore"])
        bsl = baseline["windows"][idx]
        seld = sel["windows"][idx]
        degr = round(seld["test"]["expectancyR"] - seld["train"]["expectancyR"], 4)
        overfit = seld["train"]["expectancyR"] > 0 and seld["test"]["expectancyR"] < 0
        # record the chosen value for EVERY search param this fold ("baseline" if unchanged),
        # so stability reflects how often a param is actually moved across folds.
        for k in space.keys():
            selected_params.setdefault(k, []).append(sel["changed"].get(k, "baseline"))
        test_exp.append(seld["test"]["expectancyR"])
        warns = []
        if seld["test"]["n"] < min_sample:
            warns.append(f"thin test sample (n={seld['test']['n']})")
        if overfit:
            warns.append("train>0 but test<0 (overfit)")
        fold_rows.append({
            "window": idx, "windowMeta": win_meta[idx],
            "selected": {"changed": sel["changed"], "train": seld["train"], "val": seld["val"],
                         "test": seld["test"], "trainToTestDegradationR": degr, "overfit": overfit},
            "baseline": {"train": bsl["train"], "val": bsl["val"], "test": bsl["test"]},
            "selectedBeatsBaselineOOS": seld["test"]["expectancyR"] > bsl["test"]["expectancyR"],
            "warnings": warns,
        })

    folds_n = len(fold_rows)
    beats = sum(1 for f in fold_rows if f["selectedBeatsBaselineOOS"])
    pos_test = sum(1 for x in test_exp if x > 0)
    mean_test = round(_st.mean(test_exp), 4) if test_exp else 0.0
    std_test = round(_st.pstdev(test_exp), 4) if len(test_exp) > 1 else 0.0
    param_stability = {k: {"values": v, "distinct": len(set(map(str, v))),
                           "stable": len(set(map(str, v))) == 1} for k, v in selected_params.items()}
    overall_warn = []
    if folds_n < 3:
        overall_warn.append("few folds — low statistical confidence")
    if pos_test <= folds_n / 2:
        overall_warn.append("selected config not positive out-of-sample in a majority of folds")
    if any(not p["stable"] for p in param_stability.values()):
        overall_warn.append("selected parameters drift across folds (low stability)")

    job.drilldown = {"candidates": [], "trades": []}
    span_days = round((rows[-1]["startTime"] - rows[0]["startTime"]) / 86_400_000, 1)
    job.result = _scrub({
        "mode": "walk_forward", "symbol": symbol, "timeframe": timeframe,
        "baseConfig": base_cfg.to_dict(), "exitConfig": exit_cfg.to_dict(), "exitModel": exit_model,
        "range": {"minStart": rows[0]["startTime"], "maxStart": rows[-1]["startTime"], "bars": n,
                  "spanDays": span_days, "truncated": truncated, "maxBars": MAX_JOB_BARS},
        "orderflow": {"source5sActive": used5s},
        "search": {"method": opt.get("method", "coordinate"), "params": list(space.keys()),
                   "configsEvaluated": total, "seed": opt.get("seed", 1)},
        "windows": win_meta, "folds": fold_rows,
        "stability": {"folds": folds_n, "selectedBeatsBaselineOOS": beats, "testPositiveFolds": pos_test,
                      "meanTestExpectancyR": mean_test, "stdTestExpectancyR": std_test,
                      "paramStability": param_stability},
        "warnings": overall_warn,
        "note": "Walk-forward on stored data — optimise on train, report on test. Slightly-negative after costs is expected; confirm on full 5y GC before adopting.",
    })
    job.set_progress(phase="done", current=total, total=total, message="complete")


# ------------------------------------------------------------------ start jobs
async def start_large_job(pg, symbol, timeframe, start_ms, end_ms, cfg: Sc1Config,
                          exit_cfg: ExitConfig, use_5s: bool, params_echo: dict) -> dict:
    symbol = symbol.upper()
    if MANAGER.has_active():
        return {"ok": False, "error": "a research job is already running; wait for it or cancel it"}
    rows, five_s, tick_ts, tick_px, used5s, truncated, lo, hi = await _load_range(pg, symbol, timeframe, start_ms, end_ms, use_5s)
    if len(rows) < 30:
        return {"ok": False, "error": f"not enough candles in range (got {len(rows)})"}
    job = MANAGER.create("large_run", params_echo)
    MANAGER.submit(job, lambda j: _large_run_worker(j, rows, five_s, tick_ts, tick_px, cfg, exit_cfg,
                                                     symbol, timeframe, used5s, truncated, lo, hi))
    return {"ok": True, "job": job.to_public()}


async def start_walkforward_job(pg, symbol, timeframe, start_ms, end_ms, base_cfg: Sc1Config,
                                exit_cfg: ExitConfig, use_5s: bool, wf: dict, opt: dict, params_echo: dict) -> dict:
    symbol = symbol.upper()
    if MANAGER.has_active():
        return {"ok": False, "error": "a research job is already running; wait for it or cancel it"}
    rows, five_s, tick_ts, tick_px, used5s, truncated, lo, hi = await _load_range(pg, symbol, timeframe, start_ms, end_ms, use_5s)
    if not rows:
        return {"ok": False, "error": "no candles in range"}
    try:
        _ds.make_windows(len(rows), windows=wf["windows"], train_frac=wf["trainFrac"],
                         val_frac=wf["valFrac"], test_frac=wf["testFrac"])
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    job = MANAGER.create("walk_forward", params_echo)
    MANAGER.submit(job, lambda j: _walkforward_worker(j, rows, five_s, tick_ts, tick_px, base_cfg, exit_cfg,
                                                       symbol, timeframe, used5s, truncated, lo, hi, wf, opt))
    return {"ok": True, "job": job.to_public()}


# ------------------------------------------------------------------ job access
def _page(items: list, page: int, size: int) -> dict:
    size = max(1, min(int(size), 500))
    page = max(0, int(page))
    total = len(items)
    start = page * size
    return {"page": page, "pageSize": size, "total": total,
            "pages": (total + size - 1) // size if size else 0, "items": items[start:start + size]}


def job_status(job_id: str) -> dict:
    job = MANAGER.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    pub = job.to_public()
    pub["ok"] = True
    if job.status == "done" and job.result is not None:
        pub["result"] = job.result
    return pub


def job_list() -> dict:
    return {"ok": True, "jobs": MANAGER.list()}


def job_cancel(job_id: str) -> dict:
    return {"ok": MANAGER.cancel(job_id), "jobId": job_id}


def job_candidates(job_id: str, page: int = 0, size: int = 100, klass: Optional[str] = None,
                   side: Optional[str] = None) -> dict:
    job = MANAGER.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    items = job.drilldown.get("candidates", [])
    if klass:
        items = [c for c in items if c.get("klass") == klass]
    if side:
        items = [c for c in items if c.get("side") == side]
    return {"ok": True, "jobId": job_id, "drilldownSampleOnly": True, **_page(items, page, size)}


def job_trades(job_id: str, page: int = 0, size: int = 100, exit_model: Optional[str] = None,
               klass: Optional[str] = None, side: Optional[str] = None, result: Optional[str] = None) -> dict:
    job = MANAGER.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    items = job.drilldown.get("trades", [])
    if exit_model:
        items = [t for t in items if t.get("exit_model") == exit_model]
    if klass:
        items = [t for t in items if t.get("candidate_class") == klass]
    if side:
        items = [t for t in items if t.get("side") == side]
    if result in ("win", "loss"):
        want = result == "win"
        items = [t for t in items if t.get("win") == want]
    return {"ok": True, "jobId": job_id, "drilldownSampleOnly": True, **_page(items, page, size)}


def job_matrix(job_id: str) -> dict:
    job = MANAGER.get(job_id)
    if not job or job.result is None:
        return {"ok": False, "error": "job not found or not complete"}
    r = job.result
    return {"ok": True, "jobId": job_id, "models": r.get("models", []),
            "matrix": r.get("matrix", []), "overall": r.get("overall", {})}
