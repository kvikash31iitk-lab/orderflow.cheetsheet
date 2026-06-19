"""Simulated broker: order matching + signed average-price position PnL."""
import pytest

from app.orderflow.models import Tick, TradeSide
from app.trading.broker import SimulatedBroker


def _tick(price):
    return Tick("X", 1, price, 1, side=TradeSide.BUY)


def _broker(last=100.0):
    b = SimulatedBroker()
    b.on_tick(_tick(last))   # seed a last price
    return b


# ------------------------------- order matching -------------------------------
def test_buy_limit_fills_when_tick_trades_through():
    b = _broker(100.0)
    o = b.place_order("X", "buy", "limit", 10, price=99.0)
    assert o.status == "working" and len(b.orders) == 1   # below market -> rests
    b.on_tick(_tick(99.5))                                 # not yet through 99
    assert len(b.orders) == 1
    b.on_tick(_tick(98.5))                                 # trades through 99 -> fill
    assert len(b.orders) == 0 and len(b.fills) == 1
    assert b.positions["X"].qty == 10 and b.positions["X"].entry_price == 99.0


def test_sell_limit_fills_when_tick_trades_up_through():
    b = _broker(100.0)
    b.place_order("X", "sell", "limit", 5, price=101.0)
    b.on_tick(_tick(100.5))
    assert len(b.orders) == 1
    b.on_tick(_tick(101.5))     # trades up through 101 -> sell fills
    assert len(b.orders) == 0 and b.positions["X"].qty == -5


def test_marketable_limit_fills_immediately():
    b = _broker(100.0)
    # buy limit ABOVE market is immediately marketable
    o = b.place_order("X", "buy", "limit", 3, price=101.0)
    assert o.status == "filled" and b.positions["X"].qty == 3 and len(b.orders) == 0


def test_market_order_fills_at_last_price():
    b = _broker(100.0)
    o = b.place_order("X", "buy", "market", 7)
    assert o.status == "filled"
    assert b.positions["X"].qty == 7 and b.positions["X"].entry_price == 100.0


def test_market_order_without_price_is_rejected():
    b = SimulatedBroker()   # no tick -> no last price
    o = b.place_order("X", "buy", "market", 1)
    assert o.status == "cancelled" and not b.positions


def test_cancel_working_order():
    b = _broker(100.0)
    o = b.place_order("X", "buy", "limit", 10, price=98.0)
    assert b.cancel_order(o.id) is True and len(b.orders) == 0
    assert b.cancel_order(o.id) is False        # already gone


# ------------------------------- position PnL -------------------------------
def test_avg_entry_on_adds():
    b = _broker(100.0)
    b.place_order("X", "buy", "market", 10)            # 10 @ 100
    b.on_tick(_tick(110.0))
    b.place_order("X", "buy", "market", 10)            # +10 @ 110
    assert b.positions["X"].qty == 20
    assert b.positions["X"].entry_price == 105.0       # (100*10 + 110*10)/20


def test_realised_pnl_on_partial_close():
    b = _broker(100.0)
    b.place_order("X", "buy", "market", 10)            # long 10 @ 100
    b.on_tick(_tick(110.0))
    b.place_order("X", "sell", "market", 4)            # close 4 @ 110
    p = b.positions["X"]
    assert p.qty == 6 and p.entry_price == 100.0       # entry unchanged on reduce
    assert p.realised_pnl == pytest.approx(40.0)       # (110-100)*4


def test_realised_pnl_and_flip_on_oversell():
    b = _broker(100.0)
    b.place_order("X", "buy", "market", 10)            # long 10 @ 100
    b.on_tick(_tick(110.0))
    b.place_order("X", "sell", "market", 15)           # close 10 + flip short 5
    p = b.positions["X"]
    assert p.realised_pnl == pytest.approx(100.0)      # (110-100)*10 on the close
    assert p.qty == -5 and p.entry_price == 110.0      # new short entry at fill price


def test_short_position_realised_and_unrealised():
    b = _broker(100.0)
    b.place_order("X", "sell", "market", 10)           # short 10 @ 100
    assert b.unrealised_pnl("X", 90.0) == pytest.approx(100.0)   # short profits as price drops
    b.on_tick(_tick(90.0))
    b.place_order("X", "buy", "market", 4)             # cover 4 @ 90
    assert b.positions["X"].realised_pnl == pytest.approx(40.0)  # (90-100)*4*(-1)


def test_flatten_closes_position_and_cancels_orders():
    b = _broker(100.0)
    b.place_order("X", "buy", "market", 8)             # long 8
    b.place_order("X", "buy", "limit", 5, price=95.0)  # resting order
    b.on_tick(_tick(105.0))
    b.flatten("X")
    assert b.positions["X"].qty == 0 and len(b.orders) == 0
    assert b.positions["X"].realised_pnl == pytest.approx(40.0)  # (105-100)*8


# ------------------------------- event stream -------------------------------
def test_fill_emits_fill_position_orders_messages():
    b = _broker(100.0)
    b.drain()   # clear the seed-tick state messages
    b.place_order("X", "buy", "market", 2)
    types = [m["type"] for m in b.drain()]
    assert "fill" in types and "position" in types and "orders" in types


def test_state_snapshot_shape():
    b = _broker(100.0)
    b.place_order("X", "buy", "limit", 3, price=98.0)
    st = b.state()
    assert set(st) == {"positions", "orders", "fills"}
    assert len(st["orders"]) == 1 and st["orders"][0]["price"] == 98.0


# ------------------------------- validation & residues -------------------------------
def test_place_order_validation_rejects():
    b = _broker(100.0)
    # negative qty
    o1 = b.place_order("X", "buy", "limit", -5, price=99.0)
    assert o1.status == "rejected"
    # zero qty
    o2 = b.place_order("X", "buy", "limit", 0, price=99.0)
    assert o2.status == "rejected"
    # negative price
    o3 = b.place_order("X", "buy", "limit", 5, price=-10.0)
    assert o3.status == "rejected"
    # limit without price
    o4 = b.place_order("X", "buy", "limit", 5, price=None)
    assert o4.status == "rejected"
    # invalid side
    o5 = b.place_order("X", "hold", "market", 5)
    assert o5.status == "rejected"


def test_pnl_residue_fully_closed():
    b = _broker(100.0)
    b.place_order("X", "buy", "market", 1.0)
    b.on_tick(_tick(110.0))
    # sell 0.9999999995 (leaves 5e-10, which is < 1e-9)
    b.place_order("X", "sell", "market", 0.9999999995)
    p = b.positions["X"]
    # pos qty should be fully zeroed
    assert p.qty == 0.0
    # entire realised pnl should be booked including the residue
    assert p.realised_pnl == pytest.approx(10.0)
    assert p.entry_price == 0.0

