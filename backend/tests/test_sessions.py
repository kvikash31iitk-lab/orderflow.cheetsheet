"""CME / NSE trading-session boundaries (DST-aware) + per-session CVD reset."""
from datetime import datetime
from zoneinfo import ZoneInfo

from app.market_data.aggregator import Aggregator
from app.market_data.sessions import get_session_bounds, get_session_id, in_session
from app.orderflow.models import Tick, TradeSide

CT = ZoneInfo("America/Chicago")
IST = ZoneInfo("Asia/Kolkata")


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


# ----------------------------- CME -----------------------------
def test_cme_session_rolls_at_17_ct():
    # Trade date rolls at 17:00 CT: 15:59 is still today's session, 17:00 is next.
    before = _ms(datetime(2026, 6, 18, 15, 59, tzinfo=CT))
    at_open = _ms(datetime(2026, 6, 18, 17, 0, tzinfo=CT))
    assert get_session_id("GC.V.0", before) == "CME-2026-06-18"
    assert get_session_id("GC.V.0", at_open) == "CME-2026-06-19"
    assert get_session_id("GC.V.0", before) != get_session_id("GC.V.0", at_open)


def test_cme_break_is_not_in_session():
    # 16:00-17:00 CT daily maintenance break -> not a tradeable session.
    assert in_session("GC.V.0", _ms(datetime(2026, 6, 18, 16, 30, tzinfo=CT))) is False
    assert in_session("GC.V.0", _ms(datetime(2026, 6, 18, 16, 59, tzinfo=CT))) is False
    assert in_session("GC.V.0", _ms(datetime(2026, 6, 18, 17, 30, tzinfo=CT))) is True
    assert in_session("GC.V.0", _ms(datetime(2026, 6, 18, 9, 0, tzinfo=CT))) is True


def test_cme_dst_offsets_differ_june_vs_december():
    # zoneinfo resolves DST: 17:00 CT is CDT (UTC-5) in June, CST (UTC-6) in December.
    jun = datetime(2026, 6, 18, 17, 0, tzinfo=CT)
    dec = datetime(2026, 12, 18, 17, 0, tzinfo=CT)
    assert jun.utcoffset().total_seconds() / 3600 == -5
    assert dec.utcoffset().total_seconds() / 3600 == -6
    # the session still rolls correctly at 17:00 local in BOTH regimes
    assert get_session_id("GC.V.0", _ms(jun)) == "CME-2026-06-19"
    assert get_session_id("GC.V.0", _ms(dec)) == "CME-2026-12-19"
    assert get_session_id("GC.V.0", _ms(datetime(2026, 6, 18, 16, 30, tzinfo=CT))) == "CME-2026-06-18"
    assert get_session_id("GC.V.0", _ms(datetime(2026, 12, 18, 16, 30, tzinfo=CT))) == "CME-2026-12-18"


def test_cme_session_bounds():
    # a tick at 09:00 CT belongs to the session that opened 17:00 the previous day.
    ts = _ms(datetime(2026, 6, 18, 9, 0, tzinfo=CT))
    open_ms, close_ms = get_session_bounds("GC.V.0", ts)
    assert open_ms == _ms(datetime(2026, 6, 17, 17, 0, tzinfo=CT))
    assert close_ms == _ms(datetime(2026, 6, 18, 16, 0, tzinfo=CT))


# ----------------------------- NSE -----------------------------
def test_nse_session_rolls_at_0915_ist():
    pre = _ms(datetime(2026, 6, 18, 9, 0, tzinfo=IST))  # before open -> prior session
    post = _ms(datetime(2026, 6, 18, 9, 15, tzinfo=IST))  # at open -> this session
    assert get_session_id("NIFTY-I", pre) == "NSE-2026-06-17"
    assert get_session_id("NIFTY-I", post) == "NSE-2026-06-18"
    assert in_session("NIFTY-I", post) is True
    assert in_session("NIFTY-I", _ms(datetime(2026, 6, 18, 16, 0, tzinfo=IST))) is False


# ------------------- per-session cumulative delta -------------------
def _buy(symbol, dt, vol):
    return Tick(symbol, _ms(dt), 2000.0, vol, side=TradeSide.BUY)


def test_cme_cum_delta_resets_at_session_boundary():
    agg = Aggregator("GC.V.0", "1m", row_size=0.10)
    # session A: two 1m candles before the close
    agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 15, 58, tzinfo=CT), 10))
    ev2 = agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 15, 59, tzinfo=CT), 4))
    assert ev2.closed is not None
    assert ev2.closed.cum_delta == 10  # candle 1 CVD
    # NEXT tick after the break opens a NEW session -> CVD restarts from 0
    ev3 = agg.add_tick(_buy("GC.V.0", datetime(2026, 6, 18, 17, 1, tzinfo=CT), 1))
    assert ev3.closed is not None
    assert ev3.closed.cum_delta == 14  # candle 2 still in session A (10 + 4)
    assert ev3.live.cum_delta == 1  # candle 3 in the new session -> reset, not 15


def test_nse_cum_delta_continuous_within_session():
    # within one NSE session CVD accumulates normally (no spurious reset)
    agg = Aggregator("NIFTY-I", "1m", row_size=1.0)
    agg.add_tick(_buy("NIFTY-I", datetime(2026, 6, 18, 10, 0, tzinfo=IST), 10))
    ev = agg.add_tick(_buy("NIFTY-I", datetime(2026, 6, 18, 10, 1, tzinfo=IST), 5))
    assert ev.closed.cum_delta == 10
    assert ev.live.cum_delta == 15
