from app.market_data.tick_handler import TickHandler, classify_side
from app.orderflow.models import TradeSide


def test_classify_at_ask_is_buy():
    assert classify_side(101.0, bid=100.0, ask=101.0, last_price=None) is TradeSide.BUY
    assert classify_side(101.5, bid=100.0, ask=101.0, last_price=None) is TradeSide.BUY


def test_classify_at_bid_is_sell():
    assert classify_side(100.0, bid=100.0, ask=101.0, last_price=None) is TradeSide.SELL
    assert classify_side(99.5, bid=100.0, ask=101.0, last_price=None) is TradeSide.SELL


def test_tick_rule_between_quotes():
    # between bid/ask -> use uptick/downtick
    assert classify_side(100.5, bid=100.0, ask=101.0, last_price=100.4) is TradeSide.BUY
    assert classify_side(100.5, bid=100.0, ask=101.0, last_price=100.6) is TradeSide.SELL


def test_tick_rule_unchanged_repeats():
    assert classify_side(
        100.5, bid=100.0, ask=101.0, last_price=100.5, last_side=TradeSide.BUY
    ) is TradeSide.BUY


def test_handler_tracks_state_and_normalises():
    h = TickHandler()
    t1 = h.normalise("NIFTY-I", 1, 101.0, 5, bid=100.0, ask=101.0)
    assert t1.side is TradeSide.BUY and t1.volume == 5
    t2 = h.normalise("NIFTY-I", 2, 100.0, 3, bid=100.0, ask=101.0)
    assert t2.side is TradeSide.SELL
