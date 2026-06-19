from app.orderflow.imbalance import find_stacked, flag_imbalances
from app.orderflow.models import FootprintCandle, FootprintCell


def _candle_with(cells: dict[float, tuple[float, float]]):
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=0, end_time=60000, row_size=1.0)
    for price, (bid, ask) in cells.items():
        c.cells[price] = FootprintCell(price=price, bid_volume=bid, ask_volume=ask)
    return c


def test_diagonal_buy_imbalance():
    # ask at 101 (300) vs bid of the row below (100 -> 100) = 3.0 >= 3 -> bullish @ 101
    c = _candle_with({100.0: (100, 20), 101.0: (10, 300)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[101.0].buy_imbalance
    assert not c.cells[100.0].buy_imbalance  # bottom row: no lower neighbour
    assert not c.cells[101.0].sell_imbalance


def test_diagonal_sell_imbalance():
    # bid at 100 (300) vs ask of the row above (101 -> 100) = 3.0 >= 3 -> bearish @ 100
    c = _candle_with({100.0: (300, 10), 101.0: (20, 100)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[100.0].sell_imbalance
    assert not c.cells[101.0].sell_imbalance  # top row: no upper neighbour
    assert not c.cells[100.0].buy_imbalance


def test_min_volume_filters_noise():
    # ratio is high (9/1) but the cell's ask volume (9) is below min_volume -> no flag
    c = _candle_with({100.0: (1, 1), 101.0: (1, 9)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert not c.cells[101.0].buy_imbalance


def test_boundary_rows_never_flagged():
    # bottom row has a huge ask, top row a huge bid, but each lacks the required
    # neighbour -> neither may be flagged.
    c = _candle_with({100.0: (10, 500), 101.0: (500, 10)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert not c.cells[100.0].buy_imbalance   # bottom: no row below
    assert not c.cells[101.0].sell_imbalance  # top: no row above


def test_diagonal_imbalance_with_price_gap():
    # Rows at 100.0 and 102.0 with NO row at 101.0 (a price gap). row_size = 1.0.
    # For the 102 row, the diagonal neighbour below (101) is missing -> its bid is
    # treated as 0.0 -> 102 is a (maximal) buy imbalance. The 100 row is the bottom
    # (min_price) so it can never be a buy imbalance.
    c = _candle_with({100.0: (10, 20), 102.0: (10, 300)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[102.0].buy_imbalance          # gap below treated as 0 bid
    assert not c.cells[100.0].buy_imbalance       # bottom row, no lower neighbour
    assert not c.cells[102.0].sell_imbalance      # top row, no upper neighbour

    # A contiguous comparison still uses the real neighbour, not the gap:
    c2 = _candle_with({100.0: (200, 20), 101.0: (10, 30)})  # 101 ask 30 < min_volume
    flag_imbalances(c2, ratio=3.0, min_volume=50)
    assert not c2.cells[101.0].buy_imbalance      # ask 30 below min_volume


def test_stacked_imbalance_zone_diagonal():
    c = _candle_with({
        100.0: (100, 20),    # base
        101.0: (10, 300),    # ask 300 / below bid 100 = 3   -> bullish
        102.0: (10, 400),    # ask 400 / below bid 10  = 40  -> bullish
        103.0: (10, 350),    # ask 350 / below bid 10  = 35  -> bullish
        104.0: (300, 30),    # ask 30 < min_volume; top row -> breaks the run
    })
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[101.0].buy_imbalance
    assert c.cells[102.0].buy_imbalance
    assert c.cells[103.0].buy_imbalance
    assert not c.cells[104.0].buy_imbalance

    zones = find_stacked(c, min_count=3)
    assert len(zones) == 1
    z = zones[0]
    assert z.direction == "bullish" and z.count == 3
    assert z.start_price == 101.0 and z.end_price == 103.0


# --- audit-driven coverage: bearish gap, multi-row gap, non-integer row_size ---

def test_diagonal_imbalance_bearish_gap():
    # rows 100 and 102, no 101: sell at 100 compares bid vs the ask of the row
    # above (101), which is MISSING -> treated as 0.0 -> bearish at 100.
    c = _candle_with({100.0: (300, 10), 102.0: (20, 100)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[100.0].sell_imbalance      # bid 300 vs missing 101 ask (0)
    assert not c.cells[102.0].sell_imbalance  # top row, no upper neighbour


def test_diagonal_imbalance_multirow_gap():
    # 3-row gap: rows 100 and 103 with row_size 1. The far row (100) must NOT be
    # mistaken for 103's diagonal neighbour (which is the missing 102).
    c = _candle_with({100.0: (10, 20), 103.0: (10, 300)})
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[103.0].buy_imbalance       # neighbour 102 missing -> bid 0 -> buy
    assert not c.cells[100.0].buy_imbalance    # bottom row


def test_diagonal_imbalance_non_integer_row_size():
    # row_size 0.5: 100.5's diagonal neighbour below is the real 100.0 row.
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=0, end_time=60000, row_size=0.5)
    c.cells[100.0] = FootprintCell(price=100.0, bid_volume=100, ask_volume=20)
    c.cells[100.5] = FootprintCell(price=100.5, bid_volume=10, ask_volume=300)
    flag_imbalances(c, ratio=3.0, min_volume=50)
    assert c.cells[100.5].buy_imbalance        # ask 300 / below bid 100 = 3.0
    assert not c.cells[100.0].buy_imbalance     # bottom row
