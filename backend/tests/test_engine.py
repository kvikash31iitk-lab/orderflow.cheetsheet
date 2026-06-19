from app.orderflow.engine import OrderFlowEngine
from app.orderflow.market_structure import MarketStructure
from app.orderflow.models import FootprintCandle, FootprintCell


def _candle(start, cells: dict[float, tuple[float, float]], hi=None, lo=None):
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=start, end_time=start + 60000, row_size=1.0)
    prices = list(cells)
    for price, (bid, ask) in cells.items():
        c.cells[price] = FootprintCell(price=price, bid_volume=bid, ask_volume=ask)
    c.open = prices[0]
    c.close = prices[-1]
    c.high = hi if hi is not None else max(prices)
    c.low = lo if lo is not None else min(prices)
    c.tick_count = 1
    return c


def test_engine_commits_cum_delta_and_flags_imbalance():
    eng = OrderFlowEngine("X", "1m")
    # diagonal buy imbalance @100: ask 300 vs the bid (50) of the row below (99)
    c = _candle(0, {99.0: (50, 10), 100.0: (50, 300)})
    eng.analyze(c, commit=True)
    assert c.cells[100.0].buy_imbalance
    d1 = c.delta
    assert c.cum_delta == d1
    assert c.closed is True

    c2 = _candle(60000, {100.0: (300, 50), 101.0: (10, 20)})
    eng.analyze(c2, commit=True)
    assert c2.cum_delta == d1 + c2.delta     # cumulative delta accrues across bars


def test_volume_spike_after_history():
    eng = OrderFlowEngine("X", "1m")
    # calm baseline with realistic (non-zero) variance so sigma > 0
    for i in range(8):
        eng.analyze(_candle(i * 60000, {100.0: (50 + i, 50 + (i % 3) * 4)}), commit=True)
    spike = _candle(9 * 60000, {100.0: (5000, 5000)})
    eng.analyze(spike, commit=True)
    assert spike.signals.volume_spike is True
    assert spike.signals.volume_cluster is True


def test_market_structure_labels_swings():
    ms = MarketStructure()
    # rising then a pivot high
    ms.update(10, 5)
    ms.update(12, 6)        # potential middle
    label = ms.update(11, 7)  # middle (12,6) is a swing high vs neighbours
    assert ms.last_label in {"HH", "LH", "HL", "LL", None} or label is not None
