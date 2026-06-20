"""Tests for the SC1 V4 research engine + outcome evaluator.

Covers the bits that must be exactly right for the analytics to be trustworthy:
no-lookahead entry resolution, long/short MAE/MFE, fixed SL/TP (incl. same-bar SL-first),
trailing, time exit, opposite-signal exit, cost application, and candidate classification
(baseline / blocked_by_candle / near_miss). The engine math itself is a faithful port of
the verified SC1 V3 script; here we assert structure + the classification logic.
"""
from __future__ import annotations

import pytest

from app.research.sc1.config import ExitConfig, Sc1Config
from app.research.sc1.engine import run_engine
from app.research.sc1.exits import evaluate_candidate, resolve_entry


def _bar(o, h, l, c, st, et):
    return {"open": o, "high": h, "low": l, "close": c, "startTime": st, "endTime": et}


def _signal_plus(path):
    """A signal bar (idx 0) followed by `path` = list of (high, low, close)."""
    bars = [_bar(100, 100.2, 99.8, 100, 0, 180000)]
    for j, (hi, lo, cl) in enumerate(path):
        bars.append(_bar(cl, hi, lo, cl, (j + 1) * 180000, (j + 2) * 180000))
    return bars


def _cand(side="long", atr=1.0):
    return {"id": f"baseline:{side}:0", "klass": "baseline", "side": side, "barIndex": 0,
            "startTime": 0, "endTime": 180000, "close": 100.0, "atr": atr}


NO_COST = dict(stop_r=1.0, targets_r=[1.5, 2.0], cost_points=0.0, slippage_points=0.0,
               time_exit_bars=3, max_hold_bars=50)


# --------------------------------------------------------------- entry (no lookahead)
def test_entry_uses_first_tick_after_close():
    px, ts, src = resolve_entry(180000, next_open=101.0, signal_close=100.0,
                                tick_ts=[179000, 181000, 182000], tick_px=[99.0, 101.5, 102.0])
    assert src == "tick" and ts == 181000 and px == 101.5  # the 179000 tick is BEFORE close -> skipped


def test_entry_falls_back_to_next_open_then_close():
    px, ts, src = resolve_entry(180000, next_open=101.0, signal_close=100.0, tick_ts=[], tick_px=[])
    assert src == "next_open" and px == 101.0
    px2, _, src2 = resolve_entry(180000, next_open=None, signal_close=100.0, tick_ts=[], tick_px=[])
    assert src2 == "signal_close" and px2 == 100.0


def test_entry_rejects_tick_far_past_a_data_gap():
    # the only tick is DAYS after the signal close (a gap in tick data). Without the lag
    # guard this fabricated a huge bogus fill; now it must fall back to next_open.
    far = 180000 + 5 * 24 * 3600 * 1000
    px, ts, src = resolve_entry(180000, next_open=101.0, signal_close=100.0,
                                tick_ts=[far], tick_px=[4278.7], max_lag_ms=180000)
    assert src == "next_open" and px == 101.0
    # a tick within the lag window IS accepted
    px2, ts2, src2 = resolve_entry(180000, next_open=101.0, signal_close=100.0,
                                   tick_ts=[180050], tick_px=[100.5], max_lag_ms=180000)
    assert src2 == "tick" and px2 == 100.5


# ------------------------------------------------------------------- long exits
def test_long_tp_2r_and_excursions():
    candles = _signal_plus([(100.6, 99.9, 100.4), (101.2, 100.3, 101.0), (102.3, 101.0, 102.1)])
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), ExitConfig(**NO_COST))}
    o = om["fixed_2R"]
    assert o.reason == "tp" and o.gross_points == pytest.approx(2.0) and o.r_multiple == pytest.approx(2.0)
    assert o.mfe == pytest.approx(2.3) and o.mae == pytest.approx(0.1)
    assert o.bars_held == 3


def test_long_stop_loss():
    candles = _signal_plus([(100.3, 99.5, 99.7), (100.0, 98.5, 98.8)])  # SL=99 hit on bar 2
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), ExitConfig(**NO_COST))}
    o = om["fixed_2R"]
    assert o.reason == "sl" and o.gross_points == pytest.approx(-1.0) and o.r_multiple == pytest.approx(-1.0)
    assert o.win is False


def test_same_bar_sl_and_tp_takes_sl_conservatively():
    # bar 1 spans both SL (99) and 1.5R TP (101.5): low 98 <= SL and high 102 >= TP -> SL wins
    candles = _signal_plus([(102.0, 98.0, 100.0)])
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), ExitConfig(**NO_COST))}
    assert om["fixed_1.5R"].reason == "sl"


# ------------------------------------------------------------------ short exits
def test_short_tp_and_excursions_mirror_long():
    candles = _signal_plus([(100.1, 99.0, 99.2), (99.5, 97.9, 98.1)])  # short 2R TP = 98
    om = {o.exit_model: o for o in evaluate_candidate(_cand("short"), candles, 100.0, 180000, "tick", set(), ExitConfig(**NO_COST))}
    o = om["fixed_2R"]
    assert o.reason == "tp" and o.gross_points == pytest.approx(2.0)
    assert o.mfe == pytest.approx(2.1) and o.mae == pytest.approx(0.1)  # MFE=100-97.9, MAE=100.1-100


# --------------------------------------------------------------------- trailing
def test_trailing_locks_in_after_activation():
    # rallies to +2R (102) then reverses; trailing (1 ATR) should exit in profit, reason 'trail'
    candles = _signal_plus([(102.0, 100.5, 101.8), (102.2, 100.6, 100.7), (101.0, 99.0, 99.5)])
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), ExitConfig(**NO_COST))}
    o = om["trailing"]
    assert o.reason == "trail" and o.gross_points > 0


# ------------------------------------------------------------------- time exit
def test_time_exit_at_configured_bar():
    candles = _signal_plus([(100.5, 99.9, 100.3), (100.7, 100.0, 100.6), (100.9, 100.2, 100.8), (101.2, 100.4, 101.1)])
    cfg = ExitConfig(**{**NO_COST, "time_exit_bars": 2})  # exit at path idx 1 -> close 100.6
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), cfg)}
    o = om["time"]
    assert o.reason == "time" and o.bars_held == 2 and o.gross_points == pytest.approx(0.6)


# --------------------------------------------------------------- opposite signal
def test_opposite_signal_exit():
    candles = _signal_plus([(100.5, 99.9, 100.3), (100.7, 100.0, 100.6), (100.9, 100.2, 100.8)])
    opp = {candles[2]["startTime"]}  # opposite baseline fires on path idx 1
    om = {o.exit_model: o for o in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", opp, ExitConfig(**NO_COST))}
    o = om["opposite"]
    assert o.reason == "opposite" and o.exit_price == pytest.approx(100.6)


# -------------------------------------------------------------------- costs
def test_costs_reduce_net_not_gross():
    candles = _signal_plus([(102.3, 99.9, 102.1)])
    cfg = ExitConfig(stop_r=1.0, targets_r=[2.0], cost_points=0.2, slippage_points=0.1, max_hold_bars=50)
    o = {x.exit_model: x for x in evaluate_candidate(_cand(), candles, 100.0, 180000, "tick", set(), cfg)}["fixed_2R"]
    assert o.gross_points == pytest.approx(2.0) and o.net_points == pytest.approx(1.7)


# --------------------------------------------------------------- engine / classes
def _synth(n=300):
    out = []
    t0 = 1_700_000_000_000
    price = 2000.0
    cum = 0.0
    for i in range(n):
        sweep = (i % 40 == 20)
        o = price
        if sweep:
            l, h, c = o - 6.0, o + 1.0, o + 0.8
            buy, sell = 400, 120
        else:
            h, l, c = o + (i % 7) * 0.3 + 0.5, o - ((i % 5) * 0.3 + 0.5), o + ((i % 3) - 1) * 0.4
            buy, sell = 100 + (i % 11) * 7, 95 + (i % 9) * 6
        price = c
        vol = buy + sell
        out.append(dict(open=o, high=h, low=l, close=c, startTime=t0 + i * 180000, endTime=t0 + (i + 1) * 180000,
                        totalVolume=vol, totalAskVolume=buy, totalBidVolume=sell, delta=buy - sell, cumDelta=cum + (buy - sell),
                        poc=o, rowSize=0.1))
        cum += buy - sell
    return out


def test_engine_runs_and_emits_diagnostics():
    res = run_engine(_synth(), Sc1Config(), None)
    assert res["n"] == 300 and len(res["bars"]) > 0
    b = res["bars"][100]
    for k in ("bullStrength", "bearStrength", "netBullEdge", "components", "doji", "bullSetup", "bullCandleOk"):
        assert k in b
    assert 0 <= b["bullStrength"] <= 100 and 0 <= b["bearStrength"] <= 100


def test_engine_classifies_all_candidate_classes():
    cfg = Sc1Config(skipConflictingBars=False, i1_minStrength=30.0, i1_netEdgeSignalThreshold=10.0)
    res = run_engine(_synth(), cfg, None)
    classes = {c["klass"] for c in res["candidates"]}
    assert {"baseline", "blocked_by_candle", "near_miss"} <= classes
    # every candidate carries the diagnostics the dashboard needs
    for c in res["candidates"]:
        assert c["side"] in ("long", "short")
        assert "bullStrength" in c and "netEdge" in c and "atr" in c


def test_blocked_by_candle_requires_threshold_pass_but_filter_fail():
    # turn the candle filter ON; a blocked candidate must have passed strength+netedge
    cfg = Sc1Config(skipConflictingBars=False, i1_minStrength=30.0, i1_netEdgeSignalThreshold=10.0,
                    i1_useSignalCandleFilter=True)
    res = run_engine(_synth(), cfg, None)
    blocked = [c for c in res["candidates"] if c["klass"] == "blocked_by_candle"]
    assert blocked  # the synthetic set produces some
    for c in blocked:
        # not a doji/hammer/inv-hammer on the long side it was blocked on (else it'd pass)
        assert not (c["doji"] or c["hammer"] or c["invHammer"] or c["shootingStar"])


def test_engine_short_circuits_on_tiny_input():
    assert run_engine([{"open": 1, "high": 1, "low": 1, "close": 1, "startTime": 0, "endTime": 1}], Sc1Config(), None)["candidates"] == []


# ---------------------------------------------------------- service layer (async)
from app.research.sc1 import service as sc1_service


class _FakePg:
    """Minimal pg stand-in: synthetic 3m candles + matching ticks (so 5s reconstruction
    and tick-entry both exercise real code paths)."""
    def __init__(self):
        self.candles = _synth(220)
        self.ticks = self._ticks()

    def _ticks(self):
        out = []
        for c in self.candles:
            st = c["startTime"]
            # 6 ticks spread across the 3-min bar so 5s buckets + entry resolution have data
            for f, px, side in [(0.0, c["open"], "BUY"), (0.2, c["high"], "BUY"), (0.4, c["low"], "SELL"),
                                 (0.6, (c["high"] + c["low"]) / 2, "NEUTRAL"), (0.8, c["close"], "BUY"), (0.95, c["close"], "SELL")]:
                out.append({"symbol": "GC", "ts": int(st + f * 180000), "price": px, "volume": 5.0,
                            "bid": px - 0.1, "ask": px + 0.1, "side": side})
        # a couple ticks just past the last bar for entry on the final signal
        last = self.candles[-1]["endTime"]
        out.append({"symbol": "GC", "ts": int(last + 1000), "price": self.candles[-1]["close"], "volume": 5.0, "bid": 0, "ask": 0, "side": "BUY"})
        return out

    async def ticks_minmax(self, symbol):
        return (self.ticks[0]["ts"], self.ticks[-1]["ts"])

    async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
        return [dict(c) for c in self.candles][-limit:]

    async def recent_ticks(self, symbol, since_ms, limit=1_500_000):
        return [t for t in self.ticks if t["ts"] >= since_ms][-limit:]


async def test_service_coverage_run_compare_sweep_end_to_end():
    pg = _FakePg()
    cov = await sc1_service.coverage(pg, "GC")
    assert cov["ticks"] is not None and cov["timeframes"]

    cfg = Sc1Config(skipConflictingBars=False, i1_minStrength=30.0, i1_netEdgeSignalThreshold=10.0)
    rep = await sc1_service.run(pg, "GC", "3m", None, None, cfg, use_5s=True)
    assert rep["ok"] and rep["runId"] and rep["candidates"]
    assert rep["orderflow"]["used5s"] >= 0 and rep["orderflow"]["totalBars"] == 220

    ec = ExitConfig(cost_points=0.0, slippage_points=0.0)
    comp = sc1_service.compare_exits(rep["runId"], ec)
    assert comp["ok"] and comp["models"] and comp["matrix"]
    # every matrix cell is a well-formed summary
    for row in comp["matrix"]:
        for cell in row["cells"].values():
            assert {"n", "expectancyR", "winRate", "maxDrawdownR"} <= set(cell)
    assert comp["trades"]  # at least one scored trade

    # a missing run id degrades gracefully, not a crash
    assert sc1_service.compare_exits("deadbeef", ec)["ok"] is False

    sw = await sc1_service.sweep(pg, "GC", "3m", None, None, cfg,
                                 {"i1_minStrength": [30, 45], "i1_netEdgeSignalThreshold": [10, 60]}, ec)
    assert sw["ok"] and len(sw["leaderboard"]) == 4
    # leaderboard is sorted by objective (descending)
    objs = [r["objective"] for r in sw["leaderboard"]]
    assert objs == sorted(objs, reverse=True)


async def test_service_run_handles_empty_symbol():
    class _Empty:
        async def ticks_minmax(self, s): return None
        async def recent_footprints(self, s, tf, limit, row_size=None): return []
        async def ticks_range(self, s, a, b, limit=500_000): return []
    rep = await sc1_service.run(_Empty(), "ZZZ", "3m", None, None, Sc1Config(), use_5s=True)
    assert rep["ok"] is False and rep["candidates"] == []
