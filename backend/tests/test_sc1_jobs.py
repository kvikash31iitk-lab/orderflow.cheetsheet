"""Tests for the SC1 large-dataset job mode: walk-forward splits, optimizer, job lifecycle,
cancellation, pagination, walk-forward stability output, and NaN/Inf safety on large jobs."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from app.research.sc1 import datasets, large, optimizer
from app.research.sc1.config import ExitConfig, Sc1Config


# ----------------------------------------------------------------- fixtures
def _synth(n=1300):
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
        out.append(dict(open=o, high=h, low=l, close=c, startTime=t0 + i * 180000, endTime=t0 + (i + 1) * 180000,
                        totalVolume=buy + sell, totalAskVolume=buy, totalBidVolume=sell, delta=buy - sell,
                        cumDelta=cum + (buy - sell), poc=o, rowSize=0.1))
        cum += buy - sell
    return out


class _FakePg:
    def __init__(self, candles=None):
        self.c = candles if candles is not None else _synth()

    async def footprints_minmax(self, s, tf, row_size=None):
        return {"minStart": self.c[0]["startTime"], "maxStart": self.c[-1]["startTime"], "count": len(self.c)}

    async def footprints_range(self, s, tf, a, b, row_size=None, limit=2_000_000):
        # mirror the real method: most-recent `limit` bars in range, ascending
        return [dict(x) for x in self.c if a <= x["startTime"] <= b][-limit:]

    async def recent_ticks(self, s, since, limit=1_500_000):
        return []


async def _await_job(job_id, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = large.job_status(job_id)
        if st["status"] in ("done", "failed", "cancelled"):
            return st
        await asyncio.sleep(0.03)
    return large.job_status(job_id)


LOOSE = dict(skipConflictingBars=False, i1_minStrength=30.0, i1_netEdgeSignalThreshold=10.0)


# ------------------------------------------------------------- walk-forward splits
def test_make_windows_ordered_non_overlapping():
    ws = datasets.make_windows(1200, windows=4, train_frac=0.6, val_frac=0.2, test_frac=0.2)
    assert len(ws) == 4
    for w in ws:
        assert w.train[0] < w.train[1] <= w.val[0] < w.val[1] <= w.test[0] < w.test[1]
    # windows don't overlap and advance in time
    for a, b in zip(ws, ws[1:]):
        assert a.test[1] <= b.train[0]


def test_make_windows_guards():
    with pytest.raises(ValueError):
        datasets.make_windows(50, windows=4)          # too few bars
    with pytest.raises(ValueError):
        datasets.make_windows(1000, windows=50)        # windows too fine


# -------------------------------------------------------------------- optimizer
def test_optimizer_methods_baseline_first_and_bounded():
    sp = optimizer.select_space(["i1_minStrength", "i1_netEdgeSignalThreshold", "i1_useSignalCandleFilter"])
    for method in ("grid", "random", "coordinate"):
        cands = optimizer.generate(sp, method, budget=60, seed=5)
        assert cands[0] == {}                          # baseline always first
        assert len(cands) <= optimizer.MAX_EVALS + 1
    coord = optimizer.generate(sp, "coordinate")
    assert all(len(c) <= 1 for c in coord)             # coordinate varies one param


def test_optimizer_random_is_seeded():
    sp = optimizer.select_space(["i1_minStrength", "i1_netEdgeSignalThreshold"])
    assert optimizer.generate(sp, "random", budget=15, seed=7) == optimizer.generate(sp, "random", budget=15, seed=7)


def test_optimizer_objective_penalises():
    big = optimizer.objective({"n": 100, "expectancyR": 0.3, "maxDrawdownR": 5}, {"i1_minStrength": 40})
    thin = optimizer.objective({"n": 3, "expectancyR": 0.3, "maxDrawdownR": 5}, {"i1_minStrength": 40})
    assert thin["score"] < big["score"]                # thin sample penalised
    assert big["penalties"]["complexity"] > 0
    assert "low sample (n=3<25)" in optimizer.warnings_for({"n": 3}, {"a": 1})


# --------------------------------------------------------------- large-run job
async def test_large_run_lifecycle_pagination_and_matrix():
    pg = _FakePg()
    r = await large.start_large_job(pg, "GC", "3m", None, None, Sc1Config(**LOOSE), ExitConfig(), False, {"mode": "large_run"})
    assert r["ok"]
    st = await _await_job(r["job"]["id"])
    assert st["status"] == "done", st
    res = st["result"]
    assert res["mode"] == "large_run" and res["candidateCount"] > 0 and res["models"]
    assert res["range"]["bars"] == 1300

    jid = r["job"]["id"]
    pc = large.job_candidates(jid, page=0, size=10)
    assert pc["ok"] and pc["total"] > 0 and len(pc["items"]) <= 10 and pc["pages"] >= 1
    pc2 = large.job_candidates(jid, page=0, size=10, klass="baseline", side="long")
    assert all(c["klass"] == "baseline" and c["side"] == "long" for c in pc2["items"])
    pt = large.job_trades(jid, page=0, size=20, exit_model="fixed_2R", result="win")
    assert all(t["exit_model"] == "fixed_2R" and t["win"] for t in pt["items"])
    mx = large.job_matrix(jid)
    assert mx["ok"] and len(mx["matrix"]) == 3
    json.dumps(st, allow_nan=False)


async def test_large_run_json_safe_with_nonfinite_prices():
    candles = _synth()
    candles[300]["high"] = float("nan")
    candles[600]["close"] = float("inf")
    pg = _FakePg(candles)
    r = await large.start_large_job(pg, "GC", "3m", None, None, Sc1Config(**LOOSE), ExitConfig(), False, {})
    st = await _await_job(r["job"]["id"])
    assert st["status"] == "done", st
    json.dumps(st, allow_nan=False)
    json.dumps(large.job_trades(r["job"]["id"], 0, 50), allow_nan=False)


# ------------------------------------------------------------- walk-forward job
async def test_walkforward_job_produces_folds_and_stability():
    pg = _FakePg()
    wf = {"windows": 4, "trainFrac": 0.6, "valFrac": 0.2, "testFrac": 0.2}
    opt = {"method": "coordinate", "exitModel": "fixed_2R",
           "params": ["i1_minStrength", "i1_netEdgeSignalThreshold"], "seed": 3, "minSample": 5}
    r = await large.start_walkforward_job(pg, "GC", "3m", None, None, Sc1Config(), ExitConfig(), False, wf, opt, {})
    assert r["ok"], r
    st = await _await_job(r["job"]["id"], timeout=60)
    assert st["status"] == "done", st
    res = st["result"]
    assert len(res["folds"]) == 4
    for f in res["folds"]:
        for seg in ("train", "val", "test"):
            assert seg in f["selected"] and "expectancyR" in f["selected"][seg]
    s = res["stability"]
    assert s["folds"] == 4 and "meanTestExpectancyR" in s and "paramStability" in s
    json.dumps(st, allow_nan=False)


async def test_walkforward_rejects_bad_split():
    # too many windows for the data -> graceful rejection (not a crash), with a clear reason
    pg = _FakePg(_synth(800))
    r = await large.start_walkforward_job(pg, "GC", "3m", None, None, Sc1Config(), ExitConfig(), False,
                                          {"windows": 12, "trainFrac": 0.6, "valFrac": 0.2, "testFrac": 0.2}, {}, {})
    assert r["ok"] is False and len(r["error"]) > 0


# ----------------------------------------------------------------- lifecycle
async def test_job_cancellation():
    pg = _FakePg()
    wf = {"windows": 4, "trainFrac": 0.6, "valFrac": 0.2, "testFrac": 0.2}
    opt = {"method": "grid", "budget": 40, "minSample": 5}
    r = await large.start_walkforward_job(pg, "GC", "3m", None, None, Sc1Config(), ExitConfig(), False, wf, opt, {})
    large.job_cancel(r["job"]["id"])
    st = await _await_job(r["job"]["id"], timeout=60)
    assert st["status"] in ("cancelled", "done")       # cancels mid-run, or finished a tiny grid first


async def test_job_status_and_paging_not_found():
    assert large.job_status("nope")["ok"] is False
    assert large.job_candidates("nope")["ok"] is False
    assert large.job_cancel("nope")["ok"] is False


# ----------------------------------------------------- review-fix regressions
async def test_concurrent_job_rejected(monkeypatch):
    # only one research job's dataset may be resident at a time (OOM guard on the shared box)
    monkeypatch.setattr(large.MANAGER, "has_active", lambda: True)
    r = await large.start_large_job(_FakePg(), "GC", "3m", None, None, Sc1Config(), ExitConfig(), False, {})
    assert r["ok"] is False and "already running" in r["error"]
    r2 = await large.start_walkforward_job(_FakePg(), "GC", "3m", None, None, Sc1Config(), ExitConfig(), False,
                                           {"windows": 4, "trainFrac": 0.6, "valFrac": 0.2, "testFrac": 0.2}, {}, {})
    assert r2["ok"] is False


def test_optimizer_skips_baseline_equal_values():
    sp = optimizer.select_space(["i1_minStrength"])      # grid [35,40,45,50,55], default 45
    coord = optimizer.generate(sp, "coordinate")
    assert {} in coord                                    # baseline present
    assert {"i1_minStrength": 45} not in coord            # equals default -> excluded
    assert {"i1_minStrength": 40} in coord


def test_make_windows_last_test_reaches_n():
    ws = datasets.make_windows(1207, windows=4)
    assert ws[-1].test[1] == 1207                         # no tail bars silently dropped


async def test_large_run_keeps_most_recent_when_capped(monkeypatch):
    # cap to a tiny number -> must keep the NEWEST bars, not the oldest
    monkeypatch.setattr(large, "MAX_JOB_BARS", 200)
    pg = _FakePg(_synth(1300))
    rows, *_ = await large._load_range(pg, "GC", "3m", None, None, False)
    assert len(rows) == 200
    assert rows[-1]["startTime"] == pg.c[-1]["startTime"]   # newest bar retained
