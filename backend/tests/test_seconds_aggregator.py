"""Tests for on-demand sub-minute (5s) timeframe parsing + tick aggregation."""
from app.config import TIMEFRAME_MINUTES, is_seconds_timeframe, timeframe_to_ms
from app.market_data.seconds_aggregator import aggregate_ticks_to_candles


def test_timeframe_to_ms_minutes_unchanged():
    assert timeframe_to_ms("tick") == 0
    assert timeframe_to_ms("1m") == 60_000
    assert timeframe_to_ms("3m") == 180_000
    assert timeframe_to_ms("5m") == 300_000
    assert timeframe_to_ms("1D") == 1_440 * 60_000
    # the minute set is unchanged (no seconds leaked into the chart/live timeframes)
    assert "5s" not in TIMEFRAME_MINUTES and "5S" not in TIMEFRAME_MINUTES


def test_timeframe_to_ms_seconds():
    assert timeframe_to_ms("5s") == 5_000
    assert timeframe_to_ms("5S") == 5_000
    assert timeframe_to_ms("1s") == 1_000
    assert timeframe_to_ms("15s") == 15_000
    assert timeframe_to_ms("30S") == 30_000
    assert timeframe_to_ms("90s") is None  # > 59s not allowed
    assert timeframe_to_ms("nonsense") is None
    assert timeframe_to_ms("5") is None


def test_is_seconds_timeframe():
    assert is_seconds_timeframe("5s") and is_seconds_timeframe("5S")
    assert not is_seconds_timeframe("5m")
    assert not is_seconds_timeframe("1m")
    assert not is_seconds_timeframe("tick")
    assert not is_seconds_timeframe("1D")


def _tick(ts, price, vol, side):
    return {"ts": ts, "price": price, "volume": vol, "bid": price - 0.05, "ask": price + 0.05, "side": side}


def test_aggregate_buckets_classification_and_ohlc():
    ticks = [
        _tick(1000, 100.0, 10, "BUY"),
        _tick(2000, 101.0, 4, "SELL"),
        _tick(3000, 99.0, 6, "BUY"),
        # next 5s bucket (5000..10000)
        _tick(6000, 100.0, 5, "SELL"),
        _tick(7000, 100.0, 2, "NEUTRAL"),
    ]
    candles = aggregate_ticks_to_candles(ticks, "GC.V.0", "5s", 5000, 0.1)
    assert len(candles) == 2
    a, b = candles
    # bucket boundaries are exact integer ms
    assert a.start_time == 0 and a.end_time == 5000
    assert b.start_time == 5000 and b.end_time == 10000
    # BUY -> ask, SELL -> bid, NEUTRAL -> split 50/50 (canonical fold_tick)
    assert a.total_ask_volume == 16 and a.total_bid_volume == 4
    assert a.delta == 12 and a.total_volume == 20
    assert b.total_ask_volume == 1 and b.total_bid_volume == 6  # neutral 2 -> 1/1
    assert b.delta == -5
    # OHLC from the bucket's ticks
    assert a.open == 100.0 and a.high == 101.0 and a.low == 99.0 and a.close == 99.0


def test_aggregate_sorted_and_sparse_gaps():
    # ticks jump across an empty bucket -> only buckets with ticks produce candles,
    # and output is chronological (ascending start_time)
    ticks = [_tick(1000, 100, 3, "BUY"), _tick(16000, 100, 3, "SELL")]  # buckets 0 and 15000
    candles = aggregate_ticks_to_candles(ticks, "GC.V.0", "5s", 5000, 0.1)
    assert [c.start_time for c in candles] == [0, 15000]


def test_aggregate_empty():
    assert aggregate_ticks_to_candles([], "GC.V.0", "5s", 5000, 0.1) == []
