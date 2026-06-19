"""Tests for VWAP, stateful stacked-imbalance zones, and delta divergence."""
import calendar

import pytest

from app.config import settings
from app.market_data.aggregator import Aggregator
from app.orderflow.engine import OrderFlowEngine
from app.orderflow.footprint import add_tick as fold_tick
from app.orderflow.models import FootprintCandle, FootprintCell, Tick, TradeSide


# same-day epoch ms (2023-11-14 ~22:13 local, but date-only matters for reset)
_TS = 1_700_000_000_000


def _tick(ts, price, vol, side=TradeSide.BUY):
    return Tick("X", ts, price, vol, side=side)


def _candle(start, cells, hi=None, lo=None):
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=start, end_time=start + 60000, row_size=1.0)
    prices = list(cells)
    for price, (bid, ask) in cells.items():
        c.cells[price] = FootprintCell(price=price, bid_volume=bid, ask_volume=ask)
    c.open, c.close = prices[0], prices[-1]
    c.high = hi if hi is not None else max(prices)
    c.low = lo if lo is not None else min(prices)
    c.tick_count = 1
    return c


# ---------------------------- VWAP ----------------------------
def test_vwap_is_volume_weighted():
    agg = Aggregator("X", "1m", row_size=1.0)
    e1 = agg.add_tick(_tick(_TS, 100.0, 10))
    assert e1.live.vwap == 100.0
    e2 = agg.add_tick(_tick(_TS + 1000, 102.0, 10))      # same minute + day
    assert e2.live.vwap == 101.0                          # (100*10 + 102*10) / 20


def test_vwap_resets_on_new_day():
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(_TS, 100.0, 10))
    one_day = 24 * 60 * 60 * 1000
    e = agg.add_tick(_tick(_TS + one_day, 200.0, 5))      # next day -> sums reset
    assert e.live.vwap == 200.0


# --------------------- stacked-imbalance zones ---------------------
def _bullish_stack_candle(start):
    # diagonal buy imbalances stacked at 101/102/103 (>= 3 -> a zone)
    return _candle(start, {
        100.0: (100, 20), 101.0: (10, 300), 102.0: (10, 400),
        103.0: (10, 350), 104.0: (300, 30),
    })


def test_zone_created_then_mitigated():
    eng = OrderFlowEngine("X", "1m")
    c1 = _bullish_stack_candle(0)
    eng.analyze(c1, commit=True)
    zones = c1.signals.active_zones
    assert len(zones) == 1
    z = zones[0]
    assert z["direction"] == "bullish" and z["mitigated"] is False
    assert z["start_price"] == 101.0 and z["start_time"] == 0

    # a later candle trades below the zone's start_price -> mitigation
    c2 = _candle(60000, {99.0: (50, 50)})   # low 99 < 101
    eng.analyze(c2, commit=True)
    z_after = eng.active_zones[0]
    assert z_after["mitigated"] is True
    assert z_after["mitigation_time"] == 60000


def test_zone_not_self_mitigated():
    eng = OrderFlowEngine("X", "1m")
    # candle whose own low (100) is below its zone start (101) must NOT self-mitigate
    c1 = _bullish_stack_candle(0)
    eng.analyze(c1, commit=True)
    assert eng.active_zones[0]["mitigated"] is False


# ----------------------- delta divergence -----------------------
def test_bullish_delta_divergence():
    eng = OrderFlowEngine("X", "1m")
    for i in range(5):
        eng.analyze(_candle(i * 60000, {100.0: (50, 50)}, hi=101, lo=100), commit=True)
    # new low (99 < 100) but positive delta -> bullish divergence
    div = _candle(5 * 60000, {99.0: (10, 300)}, hi=99, lo=99)
    eng.analyze(div, commit=True)
    assert div.signals.delta_divergence is True
    assert div.signals.delta_divergence_side == "bullish"


def test_bearish_delta_divergence():
    eng = OrderFlowEngine("X", "1m")
    for i in range(5):
        eng.analyze(_candle(i * 60000, {100.0: (50, 50)}, hi=100, lo=99), commit=True)
    # new high (101 > 100) but negative delta -> bearish divergence
    div = _candle(5 * 60000, {101.0: (300, 10)}, hi=101, lo=101)
    eng.analyze(div, commit=True)
    assert div.signals.delta_divergence is True
    assert div.signals.delta_divergence_side == "bearish"


# ============================================================================
# Audit-driven coverage (independent adversarial audit, 2026)
# ============================================================================

# --------- VWAP: closed candle, cross-candle, reset, zero/neg volume ---------
def test_vwap_closed_candle_and_cross_candle_cumulative():
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(_TS, 100.0, 10))
    agg.add_tick(_tick(_TS + 1000, 102.0, 10))         # same minute -> candle A
    e = agg.add_tick(_tick(_TS + 60000, 110.0, 5))     # next minute -> closes A, opens B
    assert e.closed is not None
    assert e.closed.vwap == 101.0                       # A's own last-tick session vwap
    assert e.live.vwap == 102.8                         # (100*10 + 102*10 + 110*5) / 25


def test_vwap_reset_zeros_both_sums():
    agg = Aggregator("X", "1m", row_size=1.0)
    for i in range(5):
        agg.add_tick(_tick(_TS + i * 1000, 100.0, 1000))   # big day-1 sums
    one_day = 24 * 60 * 60 * 1000
    e = agg.add_tick(_tick(_TS + one_day, 200.0, 5))        # next day -> reset BOTH
    assert e.live.vwap == 200.0                              # a one-sum reset would differ
    assert agg.session_volume_sum == 5.0
    assert agg.session_price_volume_sum == 1000.0


def test_vwap_zero_volume_open_is_none_then_recovers():
    agg = Aggregator("X", "1m", row_size=1.0)
    e1 = agg.add_tick(_tick(_TS, 100.0, 0))             # no volume yet -> undefined
    assert e1.live.vwap is None
    e2 = agg.add_tick(_tick(_TS + 1000, 102.0, 10))
    assert e2.live.vwap == 102.0


def test_vwap_nonpositive_volume_does_not_clobber():
    # a stray zero/negative-volume tick must NOT corrupt the running VWAP
    agg = Aggregator("X", "1m", row_size=1.0)
    assert agg.add_tick(_tick(_TS, 100.0, 10)).live.vwap == 100.0
    assert agg.add_tick(_tick(_TS + 1000, 50.0, -10)).live.vwap == 100.0   # negative ignored
    assert agg.add_tick(_tick(_TS + 2000, 50.0, 0)).live.vwap == 100.0     # zero ignored
    assert agg.session_volume_sum == 10.0                                   # sum uncorrupted


def test_vwap_serialized_in_to_dict():
    agg = Aggregator("X", "1m", row_size=1.0)
    d = agg.add_tick(_tick(_TS, 100.0, 10)).live.to_dict()
    assert d["vwap"] == 100.0


# ---------------- zone mitigation: bearish + serialization ----------------
def _bearish_stack_candle(start):
    # diagonal sell imbalances stacked at 101/102/103 -> a bearish zone
    return _candle(start, {
        104.0: (20, 100), 103.0: (350, 10), 102.0: (400, 10),
        101.0: (350, 10), 100.0: (30, 300),
    })


def test_bearish_zone_mitigation():
    eng = OrderFlowEngine("X", "1m")
    c1 = _bearish_stack_candle(0)
    eng.analyze(c1, commit=True)
    z = c1.signals.active_zones[0]
    assert z["direction"] == "bearish" and z["mitigated"] is False
    # a later candle trades above end_price (103) -> bearish mitigation
    c2 = _candle(60000, {108.0: (50, 50)})   # high 108 > 103
    eng.analyze(c2, commit=True)
    assert eng.active_zones[0]["mitigated"] is True
    assert eng.active_zones[0]["mitigation_time"] == 60000


def test_active_zones_serialized_camelcase():
    eng = OrderFlowEngine("X", "1m")
    c1 = _bullish_stack_candle(0)
    eng.analyze(c1, commit=True)
    az = c1.signals.to_dict()["activeZones"]
    assert len(az) == 1
    assert set(az[0].keys()) == {
        "direction", "startPrice", "endPrice", "startTime", "mitigated", "mitigationTime",
    }
    assert az[0]["startPrice"] == 101.0 and az[0]["startTime"] == 0 and az[0]["mitigated"] is False


def test_zone_snapshot_not_mutated_after_later_mitigation():
    eng = OrderFlowEngine("X", "1m")
    c1 = _bullish_stack_candle(0)
    eng.analyze(c1, commit=True)
    assert c1.signals.to_dict()["activeZones"][0]["mitigated"] is False
    eng.analyze(_candle(60000, {99.0: (50, 50)}), commit=True)   # mitigates c1's zone
    # c1's frozen snapshot must NOT retroactively flip to mitigated
    assert c1.signals.to_dict()["activeZones"][0]["mitigated"] is False


# --------------- delta divergence: window boundaries + paths ---------------
def test_delta_divergence_window_is_exactly_five():
    eng = OrderFlowEngine("X", "1m")
    lows = [95, 100, 100, 100, 100]   # oldest in-window (5th back) is lowest at 95
    for i, lo in enumerate(lows):
        eng.analyze(_candle(i * 60000, {100.0: (50, 50)}, hi=101, lo=lo), commit=True)
    # current low 96: below 100 but ABOVE the 5th-back 95 -> must NOT fire
    div = _candle(5 * 60000, {99.0: (10, 300)}, hi=99, lo=96)
    eng.analyze(div, commit=True)
    assert div.signals.delta_divergence is False


def test_delta_divergence_skipped_on_light_path():
    eng = OrderFlowEngine("X", "1m")
    for i in range(5):
        eng.analyze(_candle(i * 60000, {100.0: (50, 50)}, hi=101, lo=100), commit=True)
    div = _candle(5 * 60000, {99.0: (10, 300)}, hi=99, lo=99)
    eng.analyze(div, commit=False)   # live/light path -> heavy detectors skipped
    assert div.signals.delta_divergence is False


def test_delta_divergence_zero_priors_no_fire_no_crash():
    eng = OrderFlowEngine("X", "1m")
    div = _candle(0, {99.0: (10, 300)}, hi=99, lo=99)   # no prior candles
    eng.analyze(div, commit=True)
    assert div.signals.delta_divergence is False


def test_delta_divergence_serialized_camelcase():
    eng = OrderFlowEngine("X", "1m")
    for i in range(5):
        eng.analyze(_candle(i * 60000, {100.0: (50, 50)}, hi=101, lo=100), commit=True)
    div = _candle(5 * 60000, {99.0: (10, 300)}, hi=99, lo=99)
    eng.analyze(div, commit=True)
    d = div.signals.to_dict()
    assert d["deltaDivergence"] is True and d["deltaDivergenceSide"] == "bullish"


# ============================================================================
# VWAP standard-deviation bands, intra-candle delta extremes, TZ-aware reset
# ============================================================================

# ---------------------- VWAP standard-deviation bands ----------------------
def test_vwap_sd_bands_match_manual_calculation():
    # ticks (100,10) and (102,10): vwap=101; E[x^2]=(100^2*10+102^2*10)/20=10202;
    # variance=10202-101^2=1.0; std=1.0 -> SD1 +/-1, SD2 +/-2.
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(_TS, 100.0, 10))
    e = agg.add_tick(_tick(_TS + 1000, 102.0, 10))
    assert e.live.vwap == 101.0
    assert e.live.vwap_sd1_upper == pytest.approx(102.0)
    assert e.live.vwap_sd1_lower == pytest.approx(100.0)
    assert e.live.vwap_sd2_upper == pytest.approx(103.0)
    assert e.live.vwap_sd2_lower == pytest.approx(99.0)
    d = e.live.to_dict()
    assert d["vwapSd1Upper"] == pytest.approx(102.0) and d["vwapSd2Lower"] == pytest.approx(99.0)


def test_vwap_sd_bands_weighted_by_volume():
    # unequal volumes: prices 100 (vol 90) and 110 (vol 10).
    # vwap = (100*90 + 110*10)/100 = 101
    # E[x^2] = (100^2*90 + 110^2*10)/100 = (900000 + 121000)/100 = 10210
    # variance = 10210 - 101^2 = 9 -> std = 3
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(_TS, 100.0, 90))
    e = agg.add_tick(_tick(_TS + 1000, 110.0, 10))
    assert e.live.vwap == pytest.approx(101.0)
    assert e.live.vwap_sd1_upper == pytest.approx(104.0)   # 101 + 3
    assert e.live.vwap_sd1_lower == pytest.approx(98.0)    # 101 - 3
    assert e.live.vwap_sd2_upper == pytest.approx(107.0)   # 101 + 6
    assert e.live.vwap_sd2_lower == pytest.approx(95.0)    # 101 - 6


def test_vwap_sd_zero_variance_identical_prices_index_scale():
    # identical prices at INDEX scale must collapse the bands exactly onto VWAP.
    # The naive E[x^2]-E[x]^2 form leaves a spurious POSITIVE residue here (~5e-7
    # for 51234.56) that max(0.0,...) does NOT clamp, spreading the bands; the
    # West accumulator yields exactly zero variance.
    agg = Aggregator("X", "1m", row_size=0.05)
    e = None
    for i in range(30):
        e = agg.add_tick(_tick(_TS + i * 1000, 51234.56, 7))
    assert e.live.vwap == pytest.approx(51234.56)
    assert e.live.vwap_sd1_upper == pytest.approx(51234.56)
    assert e.live.vwap_sd1_lower == pytest.approx(51234.56)
    assert e.live.vwap_sd2_upper == pytest.approx(51234.56)
    assert e.live.vwap_sd2_lower == pytest.approx(51234.56)


def test_vwap_sd_numerically_stable_at_index_scale():
    # Tight BANKNIFTY-style consolidation at high price magnitude: the std must
    # match a numerically-stable two-pass reference. The naive sum-of-squares form
    # produced ~0.5%+ error here (and up to ~47% for sub-rupee spreads); West stays
    # at machine precision.
    import random

    import numpy as np

    random.seed(123)
    agg = Aggregator("X", "1m", row_size=0.05)
    prices: list[float] = []
    vols: list[float] = []
    e = None
    for i in range(20000):
        p = round(51500 + random.uniform(-0.5, 0.5), 2)
        v = float(random.choice([1, 2, 5, 10]))
        prices.append(p)
        vols.append(v)
        e = agg.add_tick(_tick(_TS + i * 5, p, v))
    agg_std = e.live.vwap_sd1_upper - e.live.vwap
    P = np.array(prices)
    V = np.array(vols)
    mean = np.average(P, weights=V)
    ref_std = float(np.average((P - mean) ** 2, weights=V) ** 0.5)
    assert agg_std == pytest.approx(ref_std, rel=1e-6)


# ---------------------- intra-candle delta extremes ----------------------
def test_delta_extremes_track_running_peak_and_trough():
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=0, end_time=60000, row_size=1.0)
    fold_tick(c, Tick("X", 1, 100.0, 10, side=TradeSide.BUY))    # delta -> +10
    assert c.max_delta == 10 and c.min_delta == 0
    fold_tick(c, Tick("X", 2, 100.0, 30, side=TradeSide.SELL))   # delta -> -20
    assert c.max_delta == 10 and c.min_delta == -20
    fold_tick(c, Tick("X", 3, 100.0, 5, side=TradeSide.BUY))     # delta -> -15
    assert c.max_delta == 10 and c.min_delta == -20              # extremes retained
    d = c.to_dict()
    assert d["maxDelta"] == 10 and d["minDelta"] == -20


def test_delta_extremes_serialized_via_aggregator():
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(_TS, 100.0, 40, side=TradeSide.BUY))
    e = agg.add_tick(_tick(_TS + 1000, 100.0, 100, side=TradeSide.SELL))
    assert e.live.max_delta == 40 and e.live.min_delta == -60   # +40 then -60


# ---------------------- timezone-aware daily reset ----------------------
def _utc_ms(y, mo, d, h, mi):
    """Epoch ms for a UTC wall-clock instant (host-TZ independent)."""
    return calendar.timegm((y, mo, d, h, mi, 0, 0, 0, 0)) * 1000


def test_vwap_reset_respects_exchange_timezone_offset():
    # Same two timestamps straddling 00:00 UTC; the reset must fire for a UTC
    # exchange (offset 0) but NOT for an IST exchange (offset 330), where that
    # instant is 05:30 IST — mid-session on the same IST calendar day.
    cfg_utc = settings.model_copy(update={"exchange_timezone_offset_minutes": 0})
    cfg_ist = settings.model_copy(update={"exchange_timezone_offset_minutes": 330})
    ts_before = _utc_ms(2024, 1, 15, 23, 59)   # 23:59 UTC / 05:29 IST(16th)
    ts_after = _utc_ms(2024, 1, 16, 0, 0)      # 00:00 UTC / 05:30 IST(16th)

    agg_utc = Aggregator("X", "1m", row_size=1.0, cfg=cfg_utc)
    agg_utc.add_tick(_tick(ts_before, 100.0, 10))
    e_utc = agg_utc.add_tick(_tick(ts_after, 200.0, 5))
    assert e_utc.live.vwap == 200.0            # UTC day rolled -> session reset

    agg_ist = Aggregator("X", "1m", row_size=1.0, cfg=cfg_ist)
    agg_ist.add_tick(_tick(ts_before, 100.0, 10))
    e_ist = agg_ist.add_tick(_tick(ts_after, 200.0, 5))
    # no reset -> cumulative (100*10 + 200*5) / 15 = 133.33
    assert e_ist.live.vwap == pytest.approx(2000.0 / 15)


def test_vwap_reset_fires_at_ist_midnight():
    # offset 330: a tick at 18:29 UTC (23:59 IST) then 18:30 UTC (00:00 IST next
    # day) must reset the session at the IST midnight boundary.
    cfg_ist = settings.model_copy(update={"exchange_timezone_offset_minutes": 330})
    agg = Aggregator("X", "1m", row_size=1.0, cfg=cfg_ist)
    agg.add_tick(_tick(_utc_ms(2024, 1, 15, 18, 29), 100.0, 10))   # 23:59 IST (15th)
    e = agg.add_tick(_tick(_utc_ms(2024, 1, 15, 18, 30), 200.0, 5))  # 00:00 IST (16th)
    assert e.live.vwap == 200.0                                     # IST day rolled


def test_vwap_reset_negative_offset_us_eastern():
    # offset -300 (US Eastern, EST): the exchange day boundary is at 05:00 UTC.
    # gmtime must handle the negative epoch shift correctly.
    cfg = settings.model_copy(update={"exchange_timezone_offset_minutes": -300})

    # straddle 05:00 UTC (= EST midnight) -> reset
    agg = Aggregator("X", "1m", row_size=1.0, cfg=cfg)
    agg.add_tick(_tick(_utc_ms(2024, 1, 15, 4, 59), 100.0, 10))    # 23:59 EST (14th)
    e = agg.add_tick(_tick(_utc_ms(2024, 1, 15, 5, 0), 200.0, 5))   # 00:00 EST (15th)
    assert e.live.vwap == 200.0

    # straddle 00:00 UTC (= 19:00 EST, mid-session same EST day) -> NO reset
    agg2 = Aggregator("X", "1m", row_size=1.0, cfg=cfg)
    agg2.add_tick(_tick(_utc_ms(2024, 1, 15, 23, 59), 100.0, 10))   # 18:59 EST (15th)
    e2 = agg2.add_tick(_tick(_utc_ms(2024, 1, 16, 0, 0), 200.0, 5))  # 19:00 EST (15th)
    assert e2.live.vwap == pytest.approx(2000.0 / 15)


# ---------------- session-hour-aware reset (resets at open, not midnight) -------
def test_vwap_reset_at_session_open_not_midnight():
    cfg = settings.model_copy(update={
        "exchange_timezone_offset_minutes": 330,   # IST
        "exchange_session_start": "09:15",         # NSE open
    })
    # (a) crossing 09:15 IST starts a new session -> reset
    agg = Aggregator("X", "1m", row_size=1.0, cfg=cfg)
    agg.add_tick(_tick(_utc_ms(2024, 1, 15, 3, 44), 100.0, 10))    # 09:14 IST -> prev session
    e = agg.add_tick(_tick(_utc_ms(2024, 1, 15, 3, 45), 200.0, 5))  # 09:15 IST -> new session
    assert e.live.vwap == 200.0

    # (b) crossing IST *midnight* mid-session must NOT reset (both belong to the
    # session that opened at the prior 09:15)
    agg2 = Aggregator("X", "1m", row_size=1.0, cfg=cfg)
    agg2.add_tick(_tick(_utc_ms(2024, 1, 15, 18, 29), 100.0, 10))   # 23:59 IST (15th)
    e2 = agg2.add_tick(_tick(_utc_ms(2024, 1, 15, 18, 30), 200.0, 5))  # 00:00 IST (16th)
    assert e2.live.vwap == pytest.approx(2000.0 / 15)               # no reset


# ============================================================================
# Replay automatic TrueData tick backfill
# ============================================================================
class _FakePG:
    """Minimal async stand-in for PostgresRepo used by the replay backfill tests."""

    def __init__(self, initial=None):
        self._store = list(initial or [])
        self.inserted: list[dict] = []

    async def ticks_range(self, symbol, start, end, limit=500_000):
        return list(self._store)

    async def insert_ticks(self, rows):
        self.inserted.extend(rows)
        self._store.extend(rows)


class _FakeClient:
    def __init__(self, history):
        self._history = history
        self.calls: list[tuple] = []

    async def get_history(self, symbol, duration="1 D", bar_size="tick"):
        self.calls.append((symbol, duration, bar_size))
        return self._history


async def test_replay_backfills_when_db_empty():
    from app.replay.replay_engine import ReplayEngine

    history = [
        {"symbol": "X", "timestamp": 1_700_000_000_000, "price": 100.0, "volume": 5, "bid": 99.5, "ask": 100.0},
        {"symbol": "X", "timestamp": 1_700_000_001_000, "price": 100.5, "volume": 3, "bid": 100.0, "ask": 100.5},
    ]
    pg = _FakePG()
    client = _FakeClient(history)
    rep = ReplayEngine(pg, connections=None, cfg=settings, client=client)
    n = await rep.load("X", 1_700_000_000_000, 1_700_000_000_000 + 2 * 3_600_000, "1m")
    assert client.calls == [("X", "2 H", "tick")]   # duration = (end-start)//3.6e6 hours
    assert len(pg.inserted) == 2                      # normalised history persisted
    assert all("side" in r for r in pg.inserted)      # aggressor side classified
    assert n == 2                                     # reloaded from DB after insert


async def test_replay_no_backfill_when_db_has_ticks():
    from app.replay.replay_engine import ReplayEngine

    pg = _FakePG(initial=[{"symbol": "X", "ts": 1, "price": 100.0, "volume": 1, "bid": None, "ask": None, "side": "BUY"}])
    client = _FakeClient([])
    rep = ReplayEngine(pg, connections=None, cfg=settings, client=client)
    n = await rep.load("X", 0, 3_600_000, "1m")
    assert client.calls == []   # local data present -> no backfill
    assert n == 1


async def test_replay_no_backfill_without_client():
    from app.replay.replay_engine import ReplayEngine

    rep = ReplayEngine(_FakePG(), connections=None, cfg=settings, client=None)
    n = await rep.load("X", 0, 3_600_000, "1m")
    assert n == 0   # empty DB and no client -> nothing to replay
