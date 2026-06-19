from app.orderflow.models import FootprintCandle, FootprintCell, Signals
from app.orderflow.research import evaluate_signal, validate


def test_evaluate_signal_long_metrics():
    out = evaluate_signal(entry=100.0, side="long", forward_closes=[101.0, 99.0, 103.0])
    assert out is not None
    assert out.mfe == 3.0           # best move +3
    assert out.mae == 1.0           # worst adverse 1 point
    assert out.ret == 3.0 and out.win is True


def test_evaluate_signal_short_metrics():
    out = evaluate_signal(entry=100.0, side="short", forward_closes=[99.0, 98.0])
    assert out.mfe == 2.0 and out.ret == 2.0 and out.win is True


def _ad_candle(start, close, ad_value):
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=start, end_time=start + 60000, row_size=1.0)
    c.close = close
    c.cells[close] = FootprintCell(price=close, ask_volume=max(ad_value, 0), bid_volume=max(-ad_value, 0))
    c.signals = Signals(ad=True, ad_value=ad_value)
    return c


def test_validate_collects_outcomes():
    # bullish AD at 100 followed by higher closes -> a win
    candles = [
        _ad_candle(0, 100.0, +500),
        _ad_candle(60000, 101.0, 0),
        _ad_candle(120000, 102.0, 0),
    ]
    candles[1].signals.ad = False
    candles[2].signals.ad = False
    rep = validate(candles, "AD", horizon=5)
    assert rep.n == 1
    assert rep.win_rate == 1.0
    assert rep.avg_mfe >= 2.0
