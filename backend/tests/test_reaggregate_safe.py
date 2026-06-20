"""Tests for the safe reaggregation tooling (skip-heavy large-TF guard + helpers).

These are DB-free: the skip-heavy guard and session reset run entirely in-memory through
the Aggregator/engine; the coverage gate + bound parsing are pure functions. (The
dry-run-writes-nothing / upsert-does-not-delete behavior is enforced structurally in
reaggregate_safe.main and exercised against a live DB, not here.)
"""
import importlib
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.market_data.aggregator import Aggregator
from app.orderflow.models import Tick, TradeSide

ras = importlib.import_module("reaggregate_safe")
CT = ZoneInfo("America/Chicago")


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _buy(sym, dt, price, vol):
    return Tick(sym, _ms(dt), price, vol, side=TradeSide.BUY)


def _feed(agg, ticks):
    closed = []
    for t in ticks:
        ev = agg.add_tick(t)
        if ev.closed is not None:
            closed.append(ev.closed)
    if agg.current is not None:
        closed.append(agg.engine.analyze(agg.current, commit=False))
    return closed


# ------------------------------- helpers --------------------------------
def test_parse_bound():
    assert ras._parse_bound(None) is None
    assert ras._parse_bound("1700000000000") == 1700000000000
    assert ras._parse_bound("2026-06-01") == _ms(datetime(2026, 6, 1, tzinfo=timezone.utc))


def test_covers_gate():
    ok = {"ticks": {"n": 10, "lo": 100, "hi": 200}, "footprints": {"n": 5, "lo": 120, "hi": 180}}
    starts_late = {"ticks": {"n": 10, "lo": 130, "hi": 200}, "footprints": {"n": 5, "lo": 120, "hi": 180}}
    ends_early = {"ticks": {"n": 10, "lo": 100, "hi": 170}, "footprints": {"n": 5, "lo": 120, "hi": 180}}
    empty_fp = {"ticks": {"n": 0, "lo": None, "hi": None}, "footprints": {"n": 0, "lo": None, "hi": None}}
    no_ticks = {"ticks": {"n": 0, "lo": None, "hi": None}, "footprints": {"n": 5, "lo": 120, "hi": 180}}
    assert ras._covers(ok) is True
    assert ras._covers(starts_late) is False  # would lose pre-tick history
    assert ras._covers(ends_early) is False  # would lose post-tick history
    assert ras._covers(empty_fp) is True  # nothing to lose
    assert ras._covers(no_ticks) is False


# --------------------------- skip-heavy guard ---------------------------
def _series():
    base = datetime(2026, 6, 18, 9, 0, tzinfo=CT)
    return [_buy("GC.V.0", base + timedelta(minutes=i), 2000 + (i % 5), 10 + i) for i in range(60)]


def test_skip_heavy_preserves_core_fields():
    full = _feed(Aggregator("GC.V.0", "1m", row_size=0.10, skip_heavy=False), _series())
    light = _feed(Aggregator("GC.V.0", "1m", row_size=0.10, skip_heavy=True), _series())
    assert len(full) == len(light) and len(full) > 5
    for a, b in zip(full, light):
        # OHLC / delta / cumDelta / VWAP are identical with or without the heavy detectors
        assert (a.open, a.high, a.low, a.close) == (b.open, b.high, b.low, b.close)
        assert a.delta == b.delta and a.cum_delta == b.cum_delta
        assert a.vwap == b.vwap
    # skip-heavy candles carry no volume-node / percentile signals
    assert all(not c.signals.hvn and not c.signals.lvn for c in light)
    assert all((not c.signals.absorption) and (not c.signals.lp) and (not c.signals.ad) for c in light)


def test_skip_heavy_session_reset_still_correct():
    # cumulative delta must still reset at the CME 17:00 CT session boundary in skip-heavy mode
    agg = Aggregator("GC.V.0", "1m", row_size=0.10, skip_heavy=True)
    agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 15, 58, tzinfo=CT), 2000, 10))
    ev2 = agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 15, 59, tzinfo=CT), 2000, 4))
    assert ev2.closed.cum_delta == 10
    ev3 = agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 17, 1, tzinfo=CT), 2000, 1))
    assert ev3.closed.cum_delta == 14  # candle 2, same session
    assert ev3.live.cum_delta == 1  # new session -> reset
