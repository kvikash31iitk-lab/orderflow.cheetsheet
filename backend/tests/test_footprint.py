from app.orderflow.footprint import add_tick, price_to_row
from app.orderflow.models import FootprintCandle, Tick, TradeSide


def _candle(row_size=1.0):
    return FootprintCandle(symbol="X", timeframe="1m", start_time=0, end_time=60000, row_size=row_size)


def test_price_to_row_buckets():
    assert price_to_row(100.2, 1.0) == 100.0
    assert price_to_row(100.6, 1.0) == 101.0
    assert price_to_row(23987.4, 5.0) == 23985.0


def test_add_tick_buy_then_sell():
    c = _candle()
    add_tick(c, Tick("X", 1, 100.2, 10, side=TradeSide.BUY))
    add_tick(c, Tick("X", 2, 100.2, 4, side=TradeSide.SELL))
    cell = c.cells[100.0]
    assert cell.ask_volume == 10 and cell.bid_volume == 4
    assert cell.delta == 6
    assert c.delta == 6
    assert c.total_volume == 14


def test_ohlc_tracks_extremes():
    c = _candle()
    add_tick(c, Tick("X", 1, 100.0, 1, side=TradeSide.BUY))
    add_tick(c, Tick("X", 2, 102.0, 1, side=TradeSide.BUY))
    add_tick(c, Tick("X", 3, 99.0, 1, side=TradeSide.SELL))
    assert c.open == 100.0 and c.high == 102.0 and c.low == 99.0 and c.close == 99.0


def test_neutral_splits_volume():
    c = _candle()
    add_tick(c, Tick("X", 1, 100.0, 10, side=TradeSide.NEUTRAL))
    cell = c.cells[100.0]
    assert cell.ask_volume == 5 and cell.bid_volume == 5 and cell.delta == 0


def test_poc_is_highest_volume_row():
    c = _candle()
    add_tick(c, Tick("X", 1, 100.0, 5, side=TradeSide.BUY))
    add_tick(c, Tick("X", 2, 101.0, 50, side=TradeSide.BUY))
    assert c.poc == 101.0
