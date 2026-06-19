import asyncio
import sys
import time
import types
from datetime import datetime, timezone
from types import SimpleNamespace

from app.config import Settings
from app.market_data.websocket_client import (
    MarketDataClient,
    _first_attr,
    _history_record_to_raw,
    _to_epoch_ms,
)


def test_first_attr_picks_first_present_non_none():
    obj = SimpleNamespace(a=None, b=5, c=9)
    assert _first_attr(obj, ("a", "b", "c")) == 5     # a is None -> skipped
    assert _first_attr(obj, ("x", "c")) == 9
    assert _first_attr(obj, ("x", "y"), default=42) == 42


def test_from_td_canonical_fields():
    ts = datetime(2026, 6, 16, 9, 15, tzinfo=timezone.utc)
    tick = SimpleNamespace(
        symbol="nifty-i", timestamp=ts, ltp=23990.5, ltq=7,
        best_bid_price=23990.0, best_ask_price=23991.0,
    )
    out = MarketDataClient._from_td(tick)
    assert out["symbol"] == "NIFTY-I"
    assert out["price"] == 23990.5
    assert out["volume"] == 7.0
    assert out["bid"] == 23990.0 and out["ask"] == 23991.0
    assert out["timestamp"] == int(ts.timestamp() * 1000)


def test_from_td_alternate_fields_fallback():
    # SDK variant using price/quantity/bid/ask and no timestamp attribute
    tick = SimpleNamespace(ticker="banknifty-i", price=51200.0, quantity=3, bid=51199.5, ask=51200.5)
    out = MarketDataClient._from_td(tick)
    assert out["symbol"] == "BANKNIFTY-I"
    assert out["price"] == 51200.0
    assert out["volume"] == 3.0
    assert out["bid"] == 51199.5 and out["ask"] == 51200.5
    assert out["timestamp"] > 0  # fell back to wall-clock


def test_from_td_missing_quotes_are_none():
    tick = SimpleNamespace(symbol="X", last_price=100.0, last_qty=1)
    out = MarketDataClient._from_td(tick)
    assert out["price"] == 100.0 and out["volume"] == 1.0
    assert out["bid"] is None and out["ask"] is None


# --- historical record normalisation (object OR dict; the backfill contract) ---
def test_to_epoch_ms_handles_datetime_seconds_and_ms():
    dt = datetime(2024, 1, 15, 9, 15, tzinfo=timezone.utc)
    assert _to_epoch_ms(dt) == int(dt.timestamp() * 1000)
    assert _to_epoch_ms(1_700_000_000) == 1_700_000_000_000      # seconds -> ms
    assert _to_epoch_ms(1_700_000_000_000) == 1_700_000_000_000  # already ms
    assert _to_epoch_ms(None) is None
    assert _to_epoch_ms("garbage") is None


def test_history_record_from_sdk_object():
    # truedata_ws historic records are OBJECTS, not dicts -> must still map
    rec = SimpleNamespace(
        time=datetime(2024, 1, 15, 9, 15, 30, tzinfo=timezone.utc),
        ltp=23990.5, volume=7, bid=23990.0, ask=23991.0,
    )
    out = _history_record_to_raw(rec, "nifty-i")
    assert out["symbol"] == "NIFTY-I"            # symbol injected from request
    assert out["price"] == 23990.5 and out["volume"] == 7.0
    assert out["bid"] == 23990.0 and out["ask"] == 23991.0
    assert out["timestamp"] == int(rec.time.timestamp() * 1000)


def test_history_record_from_dict_passthrough():
    rec = {"timestamp": 1_700_000_000_000, "price": 100.0, "volume": 5, "bid": 99.5, "ask": 100.0}
    out = _history_record_to_raw(rec, "X")
    assert out["symbol"] == "X" and out["price"] == 100.0 and out["timestamp"] == 1_700_000_000_000


def test_history_record_missing_essentials_dropped():
    assert _history_record_to_raw(SimpleNamespace(volume=5), "X") is None   # no ts/price


# --- connect timeout / fallback (the SDK blocks forever on "User Already Connected") ---
def _install_hanging_truedata(monkeypatch, delay=3.0):
    """Inject a fake truedata_ws whose TD() constructor blocks, mimicking the SDK
    retrying a 'User Already Connected' session forever."""
    class _HangingTD:
        def __init__(self, *a, **k):
            time.sleep(delay)        # never returns within the connect timeout

    mod_td = types.ModuleType("truedata_ws.websocket.TD")
    mod_td.TD = _HangingTD
    monkeypatch.setitem(sys.modules, "truedata_ws", types.ModuleType("truedata_ws"))
    monkeypatch.setitem(sys.modules, "truedata_ws.websocket", types.ModuleType("truedata_ws.websocket"))
    monkeypatch.setitem(sys.modules, "truedata_ws.websocket.TD", mod_td)


async def test_truedata_connect_times_out_and_abandons(monkeypatch):
    _install_hanging_truedata(monkeypatch, delay=3.0)
    cfg = Settings(force_simulator=False, use_simulator_fallback=True,
                   truedata_connect_timeout_s=0.2)
    async def _noop(_raw):  # on_tick is Callable[[dict], Awaitable[None]]
        return None
    client = MarketDataClient(_noop, cfg=cfg, symbols=["X"])
    t0 = time.monotonic()
    ok = await client._start_truedata()
    elapsed = time.monotonic() - t0
    assert ok is False                      # gave up instead of hanging
    assert client._connect_abandoned is True
    assert elapsed < 2.0                    # bounded by the 0.2s timeout, not the 3s hang


async def test_start_falls_back_to_simulator_when_truedata_hangs(monkeypatch):
    _install_hanging_truedata(monkeypatch, delay=3.0)
    cfg = Settings(force_simulator=False, use_simulator_fallback=True,
                   truedata_connect_timeout_s=0.2)
    async def _noop(_raw):  # on_tick is Callable[[dict], Awaitable[None]]
        return None
    client = MarketDataClient(_noop, cfg=cfg, symbols=["X"])
    await asyncio.wait_for(client.start(), timeout=3.0)   # startup must NOT hang
    assert client.status.source == "simulator"
    await client.stop()
