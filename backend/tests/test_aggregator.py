from app.market_data.aggregator import Aggregator, AggregatorManager, consolidate_candle
from app.orderflow.models import FootprintCandle, FootprintCell, Tick, TradeSide


def _tick(ts, price, vol, side):
    return Tick("X", ts, price, vol, side=side)


def test_time_bucket_closes_candle():
    agg = Aggregator("X", "1m", row_size=1.0)
    ev1 = agg.add_tick(_tick(1_000, 100.0, 10, TradeSide.BUY))
    assert ev1.closed is None and ev1.live.tick_count == 1

    # crosses into the next 1-minute bucket -> previous candle closes
    ev2 = agg.add_tick(_tick(61_000, 101.0, 4, TradeSide.SELL))
    assert ev2.closed is not None
    assert ev2.closed.closed is True
    assert ev2.closed.delta == 10           # only the BUY 10 was in candle 1
    assert ev2.closed.cum_delta == 10


def test_cumulative_delta_accumulates():
    agg = Aggregator("X", "1m", row_size=1.0)
    agg.add_tick(_tick(1_000, 100.0, 10, TradeSide.BUY))      # candle 1 delta +10
    agg.add_tick(_tick(61_000, 100.0, 4, TradeSide.SELL))     # closes c1, opens c2
    ev = agg.add_tick(_tick(121_000, 100.0, 1, TradeSide.BUY))  # closes c2 (delta -4)
    assert ev.closed.cum_delta == 6          # 10 + (-4)
    assert ev.live.cum_delta == 7            # running 6 + current +1


def test_tick_bars_roll_on_count():
    agg = Aggregator("X", "tick", row_size=1.0)
    from app.market_data.aggregator import TICK_BAR_SIZE

    last = None
    for i in range(TICK_BAR_SIZE + 1):
        last = agg.add_tick(_tick(1_000 + i, 100.0, 1, TradeSide.BUY))
    assert last.closed is not None  # the (TICK_BAR_SIZE+1)th tick rolled a new bar


# ---------------- dynamic row consolidation (price grouping) ----------------
def test_manager_runs_base_aggregator_and_tracks_consolidations():
    # consolidations are GROUPED from the base candle (consolidate_candle), not
    # folded natively, so the manager only routes ticks to the base aggregator and
    # records the coarser row sizes to group into.
    mgr = AggregatorManager()
    mgr.ensure("X", "1m", 1.0)   # base (default_row_size("X") == 1.0)
    mgr.ensure("X", "1m", 2.0)   # consolidation
    mgr.ensure("X", "1m", 5.0)   # consolidation

    events = mgr.process(_tick(1000, 100.0, 10, TradeSide.BUY))
    assert len(events) == 1 and events[0].live.row_size == 1.0   # base candle only
    assert sorted(mgr.consolidations_for("X", "1m")) == [2.0, 5.0]
    assert mgr.snapshot("X", "1m", 1.0).total_volume == 10
    # a tick for an unregistered symbol touches nothing
    assert mgr.process(Tick("Y", 4000, 50.0, 1, side=TradeSide.BUY)) == []


def test_consolidate_candle_reevaluates_poc_and_imbalances():
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=0, end_time=60000, row_size=1.0)
    for price, (bid, ask) in {100.0: (50, 10), 101.0: (10, 400), 102.0: (10, 20), 103.0: (300, 10)}.items():
        c.cells[price] = FootprintCell(price=price, bid_volume=bid, ask_volume=ask)
    assert c.poc == 101.0   # base POC is the 410-volume row

    cc = consolidate_candle(c, 2.0)
    # 100&101 -> bin 100 (470 vol); 102 -> 102; 103 -> 104
    assert cc.row_size == 2.0
    assert cc.total_volume == c.total_volume   # volume conserved
    assert cc.delta == c.delta                 # delta conserved
    assert cc.poc == 100.0                     # POC re-evaluated at the coarser scale
    assert set(cc.cells) == {100.0, 102.0, 104.0}
    # bid 60 vs ask 20 above -> bearish imbalance re-flagged at consolidated row 100
    assert cc.cells[100.0].sell_imbalance


def test_live_and_historical_consolidation_identical_no_seam():
    # The live broadcast groups the base live candle; the historical snapshot groups
    # the base candle reconstructed from its stored dict. Both call consolidate_candle
    # on the SAME base, so they must be byte-identical for a base>1 instrument (the
    # double-rounding seam the native-fold design suffered is gone).
    import random
    base = Aggregator("X", "1m", row_size=5.0)
    random.seed(1)
    for i in range(800):
        p = round((1000 + random.uniform(0, 40)) / 0.05) * 0.05
        base.add_tick(_tick(1000 + i, p, random.choice([1, 5, 10]), random.choice([TradeSide.BUY, TradeSide.SELL])))
    bc = base.current
    live = consolidate_candle(bc, 10.0).to_dict()
    historical = consolidate_candle(FootprintCandle.from_dict(bc.to_dict()), 10.0).to_dict()
    assert live["cells"] == historical["cells"]
    assert live["poc"] == historical["poc"]
    assert live["totalVolume"] == historical["totalVolume"]
