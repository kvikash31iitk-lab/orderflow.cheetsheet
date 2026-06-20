"""SC1 research orchestration: load data, run the engine, score exits, sweep.

Pulls closed parent candles (stored footprints) + ticks (for 5s reconstruction and
no-lookahead entry) from Postgres, runs the deterministic engine + outcome evaluator,
and shapes API-ready report dicts. Heavy per-run data (candles/ticks/candidates) is kept
in a tiny in-memory LRU keyed by run id so compare-exits / drilldown don't recompute; the
API is designed so durable persistence can be layered on later.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from datetime import datetime, timezone
from statistics import median
from typing import Optional

from ...config import settings
from ...market_data.aggregator import default_row_size
from ...market_data.seconds_aggregator import aggregate_ticks_to_candles
from .config import ExitConfig, Sc1Config
from .engine import run_engine
from .exits import TradeOutcome, evaluate_candidate, resolve_entry

# bound how much we reconstruct per run (dev/research, not the prod hot path)
MAX_RESEARCH_BARS = 12000
MAX_RESEARCH_TICKS = 2_000_000

_RUN_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_MAX = 6


def _cache_put(run_id: str, payload: dict) -> None:
    _RUN_CACHE[run_id] = payload
    _RUN_CACHE.move_to_end(run_id)
    while len(_RUN_CACHE) > _CACHE_MAX:
        _RUN_CACHE.popitem(last=False)


# --------------------------------------------------------------------- coverage
async def coverage(pg, symbol: str) -> dict:
    symbol = symbol.upper()
    out: dict = {"symbol": symbol, "ticks": None, "timeframes": [], "notes": []}
    rng = await pg.ticks_minmax(symbol)
    if rng:
        lo, hi = rng
        span_h = round((hi - lo) / 3_600_000, 1)
        out["ticks"] = {"minTs": lo, "maxTs": hi, "spanHours": span_h}
    else:
        out["notes"].append("No stored ticks for this symbol — 5s reconstruction unavailable.")
    base = default_row_size(symbol)
    for tf in ("1m", "2m", "3m", "5m", "15m", "30m"):
        rows = await pg.recent_footprints(symbol, tf, MAX_RESEARCH_BARS, row_size=base)
        if rows:
            out["timeframes"].append({
                "timeframe": tf, "count": len(rows),
                "minStart": rows[0]["startTime"], "maxStart": rows[-1]["startTime"],
            })
    if not out["timeframes"]:
        out["notes"].append("No stored footprint candles for this symbol.")
    out["notes"].append("Only ~recent VPS data is available; treat results as a HARNESS validation set, not a 5-year backtest.")
    return out


# ----------------------------------------------------------------- data loading
async def _load(pg, symbol: str, timeframe: str, start_ms: Optional[int], end_ms: Optional[int], use_5s: bool):
    base = default_row_size(symbol)
    rows = await pg.recent_footprints(symbol, timeframe, MAX_RESEARCH_BARS, row_size=base)
    if start_ms is not None:
        rows = [r for r in rows if r["startTime"] >= start_ms]
    if end_ms is not None:
        rows = [r for r in rows if r["startTime"] <= end_ms]
    rows = rows[-MAX_RESEARCH_BARS:]
    five_s = None
    tick_ts: list[int] = []
    tick_px: list[float] = []
    used_5s_window = False
    if rows:
        win_lo = rows[0]["startTime"]
        win_hi = rows[-1]["endTime"] + 5 * 60_000  # a little past the last bar for entry ticks
        ticks = await pg.ticks_range(symbol, win_lo, win_hi, limit=MAX_RESEARCH_TICKS)
        if ticks:
            tick_ts = [int(t["ts"]) for t in ticks]
            tick_px = [float(t["price"]) for t in ticks]
            if use_5s:
                cs = aggregate_ticks_to_candles(ticks, symbol, "5s", 5000, base)
                five_s = [{"startTime": c.start_time, "totalAskVolume": c.total_ask_volume,
                           "totalBidVolume": c.total_bid_volume, "delta": c.delta} for c in cs]
                used_5s_window = len(five_s) > 0
    return rows, five_s, tick_ts, tick_px, used_5s_window


# ------------------------------------------------------------------------- run
async def run(pg, symbol: str, timeframe: str, start_ms: Optional[int], end_ms: Optional[int],
              cfg: Sc1Config, use_5s: bool = True) -> dict:
    symbol = symbol.upper()
    rows, five_s, tick_ts, tick_px, used_5s_window = await _load(pg, symbol, timeframe, start_ms, end_ms, use_5s)
    if not rows:
        return {"ok": False, "error": "no candles in range", "candidates": []}
    res = run_engine(rows, cfg, five_s)
    cands = res["candidates"]

    # inventory counts
    inv = {"baseline": {"long": 0, "short": 0}, "blocked_by_candle": {"long": 0, "short": 0}, "near_miss": {"long": 0, "short": 0}}
    by_day: dict[str, dict] = {}
    for c in cands:
        inv.setdefault(c["klass"], {"long": 0, "short": 0})[c["side"]] += 1
        day = datetime.fromtimestamp(c["startTime"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        d = by_day.setdefault(day, {"baseline": 0, "blocked_by_candle": 0, "near_miss": 0})
        d[c["klass"]] += 1

    run_id = hashlib.sha1(f"{symbol}:{timeframe}:{rows[0]['startTime']}:{rows[-1]['startTime']}:{cfg.config_hash()}:{use_5s}".encode()).hexdigest()[:12]
    _cache_put(run_id, {"symbol": symbol, "timeframe": timeframe, "candles": rows, "candidates": cands,
                        "tick_ts": tick_ts, "tick_px": tick_px, "cfg": cfg})
    return {
        "ok": True, "runId": run_id, "symbol": symbol, "timeframe": timeframe,
        "configHash": cfg.config_hash(), "config": cfg.to_dict(),
        "range": {"minStart": rows[0]["startTime"], "maxStart": rows[-1]["startTime"], "bars": res["n"]},
        "orderflow": {"used5s": res["used5s"], "totalBars": res["n"], "source5sActive": used_5s_window},
        "inventory": inv, "byDay": by_day,
        "candidates": cands,
    }


# ------------------------------------------------------------- exit comparison
def _summarize(outcomes: list[TradeOutcome]) -> dict:
    if not outcomes:
        return {"n": 0, "expectancyR": 0.0, "winRate": 0.0, "profitFactor": 0.0,
                "avgMae": 0.0, "avgMfe": 0.0, "medMae": 0.0, "medMfe": 0.0, "maxDrawdownR": 0.0,
                "long": 0, "short": 0}
    rs = [o.r_multiple for o in outcomes]
    wins = [o.net_points for o in outcomes if o.net_points > 0]
    losses = [o.net_points for o in outcomes if o.net_points <= 0]
    maes = [o.mae for o in outcomes]
    mfes = [o.mfe for o in outcomes]
    # equity curve in R (by entry time) for drawdown
    seq = sorted(outcomes, key=lambda o: o.entry_time)
    eq = 0.0
    peak = 0.0
    mdd = 0.0
    for o in seq:
        eq += o.r_multiple
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    pf = (sum(wins) / abs(sum(losses))) if losses and sum(losses) != 0 else (float("inf") if wins else 0.0)
    return {
        "n": len(outcomes),
        "expectancyR": round(sum(rs) / len(rs), 4),
        "winRate": round(sum(1 for o in outcomes if o.win) / len(outcomes), 4),
        "profitFactor": round(pf, 3) if pf != float("inf") else None,
        "avgMae": round(sum(maes) / len(maes), 4), "avgMfe": round(sum(mfes) / len(mfes), 4),
        "medMae": round(median(maes), 4), "medMfe": round(median(mfes), 4),
        "maxDrawdownR": round(mdd, 4),
        "long": sum(1 for o in outcomes if o.side == "long"),
        "short": sum(1 for o in outcomes if o.side == "short"),
    }


def _opposite_times(candidates: list[dict]) -> dict:
    """Baseline opposite-signal exit times: a long exits when a baseline short fires, etc."""
    long_sig = {c["startTime"] for c in candidates if c["klass"] == "baseline" and c["side"] == "long"}
    short_sig = {c["startTime"] for c in candidates if c["klass"] == "baseline" and c["side"] == "short"}
    return {"long": short_sig, "short": long_sig}


def _eval_all(candles, candidates, tick_ts, tick_px, exit_cfg, classes) -> list[TradeOutcome]:
    opp = _opposite_times(candidates)
    by_start = {c["startTime"]: i for i, c in enumerate(candles)}
    outs: list[TradeOutcome] = []
    for cand in candidates:
        if classes and cand["klass"] not in classes:
            continue
        i = cand["barIndex"]
        nxt = candles[i + 1]["open"] if i + 1 < len(candles) else None
        entry, et, src = resolve_entry(cand["endTime"], nxt, cand["close"], tick_ts, tick_px)
        outs.extend(evaluate_candidate(cand, candles, entry, et, src, opp[cand["side"]], exit_cfg))
    return outs


def compare_exits(run_id: str, exit_cfg: ExitConfig, classes: Optional[list[str]] = None) -> dict:
    run = _RUN_CACHE.get(run_id)
    if not run:
        return {"ok": False, "error": "run not found (re-run /research/sc1/run)", "matrix": []}
    outs = _eval_all(run["candles"], run["candidates"], run["tick_ts"], run["tick_px"], exit_cfg, classes)
    models = sorted({o.exit_model for o in outs})
    klasses = ["baseline", "blocked_by_candle", "near_miss"]
    matrix = []
    for kl in klasses:
        row = {"class": kl, "cells": {}}
        for m in models:
            sub = [o for o in outs if o.candidate_class == kl and o.exit_model == m]
            row["cells"][m] = _summarize(sub)
        matrix.append(row)
    overall = {m: _summarize([o for o in outs if o.exit_model == m]) for m in models}
    return {
        "ok": True, "runId": run_id, "models": models, "matrix": matrix, "overall": overall,
        "exitConfig": exit_cfg.to_dict(),
        "trades": [o.to_dict() for o in outs],
    }


# ----------------------------------------------------------------------- sweep
async def sweep(pg, symbol: str, timeframe: str, start_ms, end_ms, base_cfg: Sc1Config,
                grid: dict[str, list], exit_cfg: ExitConfig, exit_model: str = "fixed_2R",
                use_5s: bool = True, min_sample: int = 12) -> dict:
    symbol = symbol.upper()
    rows, five_s, tick_ts, tick_px, _ = await _load(pg, symbol, timeframe, start_ms, end_ms, use_5s)
    if not rows:
        return {"ok": False, "error": "no candles in range", "leaderboard": []}
    keys = [k for k in grid if hasattr(base_cfg, k)]
    combos: list[dict] = [{}]
    for k in keys:
        combos = [{**c, k: v} for c in combos for v in grid[k]]
    combos = combos[:80]  # bounded / auditable

    base_hash = base_cfg.config_hash()
    rows_lb = []
    for combo in combos:
        cfg = base_cfg.clone(**combo)
        res = run_engine(rows, cfg, five_s)
        outs = _eval_all(rows, res["candidates"], tick_ts, tick_px, exit_cfg, ["baseline"])
        outs = [o for o in outs if o.exit_model == exit_model]
        summ = _summarize(outs)
        # objective: expectancy R, penalised for thin samples
        n = summ["n"]
        sample_pen = 0.0 if n >= min_sample else (min_sample - n) * 0.05
        objective = round(summ["expectancyR"] - sample_pen - 0.02 * summ["maxDrawdownR"], 4)
        warnings = []
        if n < min_sample:
            warnings.append(f"low sample (n={n}<{min_sample})")
        if len(combo) > 2:
            warnings.append("many params changed at once (overfit risk)")
        rows_lb.append({
            "changed": combo, "configHash": cfg.config_hash(), "isBaseline": cfg.config_hash() == base_hash,
            "objective": objective, **summ, "warnings": warnings,
        })
    rows_lb.sort(key=lambda r: r["objective"], reverse=True)
    return {"ok": True, "symbol": symbol, "timeframe": timeframe, "exitModel": exit_model,
            "baselineHash": base_hash, "leaderboard": rows_lb,
            "note": "Bounded grid on ~recent data — validation harness only; confirm on 5-year GC before adopting."}
