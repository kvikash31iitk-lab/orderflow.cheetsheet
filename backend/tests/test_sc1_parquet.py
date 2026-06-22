"""Tests for the research-only HistoricalParquetProvider + the SC1 'source' abstraction:
schema mapping (snake->camel), 1m->2m deterministic aggregation, 5s child lookup, ticks,
coverage, a real SC1 large_run driven from synthetic Parquet, and source-parity (a Pg-shaped
fake and the Parquet provider over the SAME bars yield identical candidates — i.e. the live
Postgres path is unaffected). Uses pyarrow to write tiny Parquet fixtures in a tmp dir."""
from __future__ import annotations

import asyncio
import json
import os
import time

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from app.research.sc1 import large
from app.research.sc1.config import ExitConfig, Sc1Config
from app.research.sc1.parquet_provider import HistoricalParquetProvider, check_span_days, max_research_days

# t0 is divisible by 360000 so 1m/2m/3m buckets all align to bar boundaries (deterministic agg).
T0 = 1_700_000_280_000
LOOSE = dict(skipConflictingBars=False, i1_minStrength=30.0, i1_netEdgeSignalThreshold=10.0)


def _synth_bars(n: int, tf_ms: int) -> dict:
    cols: dict[str, list] = {k: [] for k in (
        "symbol", "start_time", "end_time", "open", "high", "low", "close", "total_volume",
        "ask_volume", "bid_volume", "delta", "cum_delta", "poc", "max_delta", "min_delta",
        "tick_count", "row_size", "active_contract", "session_day", "instrument_id")}
    price, cum = 2000.0, 0.0
    for i in range(n):
        sweep = (i % 40 == 20)
        o = price
        if sweep:
            h, l, c, buy, sell = o + 1.0, o - 6.0, o + 0.8, 400, 120
        else:
            h = o + (i % 7) * 0.3 + 0.5
            l = o - ((i % 5) * 0.3 + 0.5)
            c = o + ((i % 3) - 1) * 0.4
            buy, sell = 100 + (i % 11) * 7, 95 + (i % 9) * 6
        price, d = c, buy - sell
        cum += d
        st = T0 + i * tf_ms
        for k, v in (("symbol", "GC.V.0"), ("start_time", st), ("end_time", st + tf_ms), ("open", o),
                     ("high", h), ("low", l), ("close", c), ("total_volume", float(buy + sell)),
                     ("ask_volume", float(buy)), ("bid_volume", float(sell)), ("delta", float(d)),
                     ("cum_delta", float(cum)), ("poc", round(o, 1)), ("max_delta", float(max(0, d))),
                     ("min_delta", float(min(0, d))), ("tick_count", buy + sell), ("row_size", 0.1),
                     ("active_contract", "GCM6"), ("session_day", "2026-05-01"), ("instrument_id", 19181)):
            cols[k].append(v)
    return cols


def _synth_ticks(n: int, span_ms: int, t0: int = T0) -> dict:
    cols: dict[str, list] = {k: [] for k in (
        "symbol", "ts", "price", "volume", "bid", "ask", "side", "session_day", "instrument_id", "seq")}
    for i in range(n):
        ts = t0 + int(i * span_ms / n)
        px = 2000.0 + (i % 50) * 0.1
        for k, v in (("symbol", "GC.V.0"), ("ts", ts), ("price", px), ("volume", 1.0 + (i % 5)),
                     ("bid", px - 0.1), ("ask", px + 0.1), ("side", ["BUY", "SELL", "NEUTRAL"][i % 3]),
                     ("session_day", "2026-05-01"), ("instrument_id", 19181), ("seq", i)):
            cols[k].append(v)
    return cols


def _write(cols: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pq.write_table(pa.table(cols), path, compression="zstd")


@pytest.fixture
def provider(tmp_path):
    root = str(tmp_path / "gc")
    p = "symbol=GC.V.0/year=2026/month=05"
    _write(_synth_bars(420, 60_000), os.path.join(root, "bars_1m", p, "bars_1m_2026-05.parquet"))
    _write(_synth_bars(2400, 5_000), os.path.join(root, "bars_5s", p, "bars_5s_2026-05.parquet"))
    _write(_synth_ticks(5000, 420 * 60_000), os.path.join(root, "ticks", p, "ticks_2026-05.parquet"))
    return HistoricalParquetProvider(root=root)


async def _await_job(job_id, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = large.job_status(job_id)
        if st["status"] in ("done", "failed", "cancelled"):
            return st
        await asyncio.sleep(0.03)
    return large.job_status(job_id)


# ------------------------------------------------------------------ schema mapping
async def test_schema_mapping_snake_to_camel(provider):
    rows = await provider.footprints_range("GC.V.0", "1m", None, None, limit=10)
    assert rows
    need = {"symbol", "timeframe", "startTime", "endTime", "rowSize", "open", "high", "low", "close",
            "totalVolume", "totalAskVolume", "totalBidVolume", "delta", "cumDelta", "poc",
            "maxDelta", "minDelta", "closed"}
    assert need.issubset(rows[0]), need - set(rows[0])
    assert rows[0]["timeframe"] == "1m" and rows[0]["rowSize"] == 0.1 and rows[0]["closed"] is True
    assert all(rows[i]["startTime"] < rows[i + 1]["startTime"] for i in range(len(rows) - 1))  # ascending


async def test_minmax(provider):
    mm = await provider.footprints_minmax("GC.V.0", "1m")
    assert mm and mm["count"] == 420 and mm["minStart"] == T0 and mm["maxStart"] == T0 + 419 * 60_000


# ------------------------------------------------------------------ 1m -> 2m aggregation
async def test_1m_to_2m_aggregation(provider):
    one = await provider.footprints_range("GC.V.0", "1m", None, None, limit=6)
    two = await provider.footprints_range("GC.V.0", "2m", None, None, limit=3)
    assert two and two[0]["timeframe"] == "2m"
    a, b, p = one[0], one[1], two[0]                                   # 2m bar 0 == 1m bars 0+1
    assert p["startTime"] == a["startTime"] and p["endTime"] - p["startTime"] == 120_000
    assert p["open"] == a["open"] and p["close"] == b["close"]
    assert p["high"] == max(a["high"], b["high"]) and p["low"] == min(a["low"], b["low"])
    assert abs(p["totalVolume"] - (a["totalVolume"] + b["totalVolume"])) < 1e-6
    assert abs(p["totalAskVolume"] - (a["totalAskVolume"] + b["totalAskVolume"])) < 1e-6
    assert abs(p["delta"] - (a["delta"] + b["delta"])) < 1e-6
    assert p["cumDelta"] == b["cumDelta"]                             # final running CVD of the window
    assert p["maxDelta"] == max(a["maxDelta"], b["maxDelta"])
    assert p["minDelta"] == min(a["minDelta"], b["minDelta"])


async def test_3m_aggregation_window(provider):
    three = await provider.footprints_range("GC.V.0", "3m", None, None, limit=3)
    assert three and three[0]["endTime"] - three[0]["startTime"] == 180_000


# ------------------------------------------------------------------ 5s child lookup + ticks
async def test_5s_child_lookup(provider):
    five = await provider.footprints_range("GC.V.0", "5s", None, None, limit=100)
    assert five and five[0]["timeframe"] == "5s" and (five[0]["endTime"] - five[0]["startTime"]) == 5000


async def test_recent_ticks(provider):
    one = await provider.footprints_range("GC.V.0", "1m", None, None, limit=5)
    ticks = await provider.recent_ticks("GC.V.0", one[0]["startTime"], limit=100_000)
    assert ticks and {"ts", "price", "volume", "bid", "ask", "side"}.issubset(ticks[0])
    assert ticks[0]["ts"] <= ticks[-1]["ts"]                          # ascending


# ------------------------------------------------------------------ coverage + graceful-absent
async def test_coverage(provider):
    cov = await provider.coverage("GC.V.0")
    assert cov["available"] and cov["source"] == "historical_parquet"
    assert {"1m", "5s"}.issubset({t["timeframe"] for t in cov["timeframes"]})
    assert cov["derivedTimeframes"] == ["2m", "3m"] and cov["ticks"]["count"] == 5000


async def test_missing_dir_is_graceful(tmp_path):
    p = HistoricalParquetProvider(root=str(tmp_path / "absent"))
    assert await p.footprints_minmax("GC.V.0", "1m") is None
    assert await p.footprints_range("GC.V.0", "1m", None, None) == []
    assert await p.recent_ticks("GC.V.0", 0) == []
    assert (await p.coverage("GC.V.0"))["available"] is False


# ------------------------------------------------------------------ real SC1 run from Parquet
async def test_small_sc1_large_run_from_parquet(provider):
    cfg = Sc1Config(**LOOSE)
    r = await large.start_large_job(provider, "GC.V.0", "1m", None, None, cfg, ExitConfig(), False, {"source": "historical_parquet"})
    assert r["ok"], r
    st = await _await_job(r["job"]["id"])
    assert st["status"] == "done", st
    res = st["result"]
    assert res["mode"] == "large_run" and res["symbol"] == "GC.V.0" and res["range"]["bars"] == 420
    assert isinstance(res["candidateCount"], int) and res["models"]
    json.dumps(st, allow_nan=False)                                  # NaN/Inf-safe payload


# ------------------------------------------------------------------ source parity: live path unchanged
async def test_source_parity_live_vs_parquet(provider):
    """A Postgres-shaped fake and the Parquet provider over the SAME bars produce IDENTICAL
    candidate counts — i.e. swapping `source` changes only WHERE bars come from, not the
    engine, and the existing live_postgres path is unaffected."""
    cfg = Sc1Config(**LOOSE)
    bars = await provider.footprints_range("GC.V.0", "1m", None, None, limit=1000)

    class FakePg:                                                     # mimics postgres.Provider shape
        enabled = True

        async def footprints_minmax(self, s, tf, row_size=None):
            return {"minStart": bars[0]["startTime"], "maxStart": bars[-1]["startTime"], "count": len(bars)}

        async def footprints_range(self, s, tf, a, b, row_size=None, limit=2_000_000):
            return [dict(x) for x in bars]

        async def recent_ticks(self, s, since, limit=1_500_000):
            return []

    r1 = await large.start_large_job(FakePg(), "GC.V.0", "1m", None, None, cfg, ExitConfig(), False, {})
    s1 = await _await_job(r1["job"]["id"])
    assert s1["status"] == "done", s1
    r2 = await large.start_large_job(provider, "GC.V.0", "1m", None, None, cfg, ExitConfig(), False, {})
    s2 = await _await_job(r2["job"]["id"])
    assert s2["status"] == "done", s2
    assert s1["result"]["candidateCount"] == s2["result"]["candidateCount"]
    assert s1["result"]["range"]["bars"] == s2["result"]["range"]["bars"] == 420


# ============================ SAFETY/CORRECTNESS PATCH ============================
FAR = T0 + 820 * 86_400_000   # a far-future tick block (~+2.25y) to prove window-bounded fetches


@pytest.fixture
def windowed(tmp_path):
    """Two DISJOINT tick blocks: the OLD analysis window at T0 and a FAR block ~820 days later.
    Proves historical tick fetches stay inside the requested window (the 'old window pulls 2026
    ticks' bug)."""
    root = str(tmp_path / "gc")
    p1 = "symbol=GC.V.0/year=2023/month=11"
    p2 = "symbol=GC.V.0/year=2026/month=02"
    _write(_synth_bars(420, 60_000), os.path.join(root, "bars_1m", p1, "bars_1m_old.parquet"))
    _write(_synth_ticks(4000, 420 * 60_000, t0=T0), os.path.join(root, "ticks", p1, "ticks_old.parquet"))
    _write(_synth_ticks(4000, 420 * 60_000, t0=FAR), os.path.join(root, "ticks", p2, "ticks_far.parquet"))
    return HistoricalParquetProvider(root=root)


# ---- task 1: metadata/footer-based coverage (no full-column materialisation) ----
async def test_footer_minmax_matches_bruteforce(provider):
    import glob
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    lo, hi, n = provider._footer_minmax("ticks", "ts")
    f = glob.glob(os.path.join(provider.root, "ticks", "**", "*.parquet"), recursive=True)[0]
    allts = pq.ParquetFile(f).read(columns=["ts"]).column("ts")   # single file, no partition inference
    assert n == len(allts) and lo == pc.min(allts).as_py() and hi == pc.max(allts).as_py()


async def test_footer_minmax_fallback_without_statistics(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    root = str(tmp_path / "gc")
    path = os.path.join(root, "bars_1m", "symbol=GC.V.0/year=2023/month=11", "nostats.parquet")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pq.write_table(pa.table(_synth_bars(50, 60_000)), path, write_statistics=False)  # NO stats
    prov = HistoricalParquetProvider(root=root)
    lo, hi, n = prov._footer_minmax("bars_1m", "start_time")
    assert n == 50 and lo == T0 and hi == T0 + 49 * 60_000   # correct via the read-fallback


async def test_coverage_shape_unchanged_after_footer_opt(provider):
    cov = await provider.coverage("GC.V.0")
    assert set(cov) >= {"symbol", "source", "dataRoot", "available", "ticks", "timeframes",
                        "derivedTimeframes", "notes"}
    assert cov["available"] and cov["ticks"]["count"] == 5000 and cov["ticks"]["minTs"] == T0
    assert {t["timeframe"] for t in cov["timeframes"]} >= {"1m", "5s"}
    mm = await provider.footprints_minmax("GC.V.0", "1m")
    assert mm["count"] == 420 and mm["minStart"] == T0          # footer path still exact


# ---- task 2: bounded historical tick reads (older-date regression) ----
async def test_ticks_range_stays_in_window_2023(windowed):
    lo, hi = T0, T0 + 420 * 60_000                              # the OLD (2023) window
    got = await windowed.ticks_range("GC.V.0", lo, hi)
    assert got and all(lo <= t["ts"] <= hi for t in got)
    assert max(t["ts"] for t in got) < FAR                     # NONE from the far (2026) block


async def test_recent_ticks_leaks_far_block_but_ticks_range_does_not(windowed):
    leaky = await windowed.recent_ticks("GC.V.0", T0, limit=10_000)
    assert any(t["ts"] >= FAR for t in leaky)                  # unbounded path leaks 2026 ticks ...
    bounded = await windowed.ticks_range("GC.V.0", T0, T0 + 420 * 60_000)
    assert not any(t["ts"] >= FAR for t in bounded)            # ... bounded path does not


async def test_load_range_historical_fetches_only_window(windowed):
    rows, five_s, tick_ts, tick_px, used5s, trunc, lo, hi = await large._load_range(
        windowed, "GC.V.0", "1m", T0, T0 + 420 * 60_000, True)
    assert rows and tick_ts and used5s
    assert min(tick_ts) >= T0 and max(tick_ts) < FAR          # historical run used ONLY in-window ticks


# ---- task 4: live_postgres path unchanged (still recent_ticks, never ticks_range) ----
def _fake_bars(n=40):
    return [{"symbol": "GC.V.0", "timeframe": "1m", "startTime": T0 + i * 60_000,
             "endTime": T0 + (i + 1) * 60_000, "rowSize": 0.1, "open": 2000.0, "high": 2000.5,
             "low": 1999.5, "close": 2000.1, "totalVolume": 100.0, "totalAskVolume": 55.0,
             "totalBidVolume": 45.0, "delta": 10.0, "cumDelta": 10.0 * (i + 1), "poc": 2000.0,
             "closed": True} for i in range(n)]


class _RecordingPg:
    enabled = True

    def __init__(self):
        self.calls = []
        self._bars = _fake_bars()

    async def footprints_minmax(self, s, tf, row_size=None):
        return {"minStart": self._bars[0]["startTime"], "maxStart": self._bars[-1]["startTime"], "count": len(self._bars)}

    async def footprints_range(self, s, tf, a, b, row_size=None, limit=2_000_000):
        return [dict(x) for x in self._bars]

    async def recent_ticks(self, s, since, limit=1_500_000):
        self.calls.append("recent_ticks")
        return [{"ts": self._bars[0]["startTime"] + 1, "price": 2000.0, "volume": 1.0,
                 "bid": 1999.9, "ask": 2000.1, "side": "BUY"}]

    async def ticks_range(self, s, a, b, limit=None):
        self.calls.append("ticks_range")
        return [{"ts": self._bars[0]["startTime"] + 1, "price": 2000.0, "volume": 1.0,
                 "bid": 1999.9, "ask": 2000.1, "side": "BUY"}]


async def test_live_path_unchanged_uses_recent_ticks():
    live = _RecordingPg()                                       # NO windowed_ticks attr -> live behaviour
    await large._load_range(live, "GC.V.0", "1m", None, None, True)
    assert "recent_ticks" in live.calls and "ticks_range" not in live.calls


async def test_historical_path_uses_ticks_range():
    class HistPg(_RecordingPg):
        windowed_ticks = True
    hist = HistPg()
    await large._load_range(hist, "GC.V.0", "1m", None, None, True)
    assert "ticks_range" in hist.calls and "recent_ticks" not in hist.calls


# ---- task 3: shared-box span guardrail ----
def test_span_guardrail_default_7_days():
    day = 86_400_000
    check_span_days(T0, T0 + 7 * day)                          # exactly the limit -> OK
    check_span_days(T0, T0 + 1 * day)                          # small -> OK
    for bad in [(None, T0), (T0, None), (T0, T0 + 8 * day), (T0 + day, T0)]:
        with pytest.raises(ValueError):
            check_span_days(*bad)


def test_span_guardrail_env_override(monkeypatch):
    monkeypatch.setenv("SC1_RESEARCH_MAX_DAYS", "2")
    assert max_research_days() == 2
    day = 86_400_000
    check_span_days(T0, T0 + 2 * day)                          # OK under override
    with pytest.raises(ValueError):
        check_span_days(T0, T0 + 3 * day)
