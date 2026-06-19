"""SimulatedBroker — paper trading engine (no real orders/money).

Synchronous and IO-free so it can run inside the per-tick hot path. Mutating calls
accumulate WS messages in an internal queue; the async caller (pipeline / REST route)
drains them with `drain()` and broadcasts. Position accounting is standard signed
average-price: realised PnL booked when a fill reduces/closes/flips the position.
"""
from __future__ import annotations

import time
from typing import Optional

from ..config import Settings, settings as default_settings
from ..orderflow.models import Tick
from .models import Fill, Order, Position


class SimulatedBroker:
    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self.positions: dict[str, Position] = {}
        self.orders: dict[int, Order] = {}        # working orders by id
        self.fills: list[Fill] = []
        self._last_price: dict[str, float] = {}
        self._order_seq = 0
        self._fill_seq = 0
        self._pending: list[dict] = []            # WS messages awaiting broadcast

    # ------------------------------------------------------------------ #
    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)

    def _position(self, symbol: str) -> Position:
        pos = self.positions.get(symbol)
        if pos is None:
            pos = Position(symbol=symbol)
            self.positions[symbol] = pos
        return pos

    def drain(self) -> list[dict]:
        """Return and clear queued WS messages (caller broadcasts them)."""
        msgs, self._pending = self._pending, []
        return msgs

    def _emit_state(self, symbol: str) -> None:
        """Queue position + working-orders snapshots after a state change."""
        self._pending.append({
            "type": "position",
            "symbol": symbol,
            "data": [p.to_dict(self._last_price.get(p.symbol)) for p in self.positions.values() if p.symbol == symbol]
        })
        self._pending.append({
            "type": "orders",
            "symbol": symbol,
            "data": [o.to_dict() for o in self.orders.values() if o.symbol == symbol]
        })

    # ------------------------------------------------------------------ #
    def place_order(self, symbol: str, side: str, type: str = "market",
                    qty: float = 0.0, price: Optional[float] = None) -> Order:
        side = side.lower()
        type = type.lower()
        self._order_seq += 1
        order = Order(id=self._order_seq, symbol=symbol, side=side, type=type,
                      qty=qty, price=price, status="working", timestamp=self._now())

        # Validation checks
        if qty <= 0 or (price is not None and price <= 0) or (type == "limit" and price is None) or side not in ("buy", "sell"):
            order.status = "rejected"
            self._emit_state(symbol)
            return order

        if type == "market":
            ref = self._last_price.get(symbol, price)
            if ref is not None:
                self._fill(order, ref)
            else:
                order.status = "cancelled"   # no market price yet -> cannot fill
        else:  # limit
            self.orders[order.id] = order
            last = self._last_price.get(symbol)
            # an immediately-marketable limit fills now
            if last is not None and price is not None and (
                (side == "buy" and price >= last) or (side == "sell" and price <= last)
            ):
                self._fill(order, last)

        self._emit_state(symbol)
        return order

    def cancel_order(self, order_id: int) -> bool:
        order = self.orders.get(order_id)
        if order is None or order.status != "working":
            return False
        order.status = "cancelled"
        del self.orders[order_id]
        self._emit_state(order.symbol)
        return True

    def flatten(self, symbol: str) -> None:
        """Cancel all working orders for the symbol and market-close the position."""
        for oid in [o.id for o in self.orders.values() if o.symbol == symbol]:
            o = self.orders.pop(oid)
            o.status = "cancelled"
        pos = self.positions.get(symbol)
        if pos and pos.qty:
            side = "sell" if pos.qty > 0 else "buy"
            self._order_seq += 1
            closing = Order(id=self._order_seq, symbol=symbol, side=side, type="market",
                            qty=abs(pos.qty), price=None, status="working", timestamp=self._now())
            ref = self._last_price.get(symbol, pos.entry_price)
            self._fill(closing, ref)
        self._emit_state(symbol)

    def on_tick(self, tick: Tick) -> None:
        """Update last price and fill any working limit orders the tick trades through."""
        self._last_price[tick.symbol] = tick.price
        touched = False
        for order in [o for o in self.orders.values() if o.symbol == tick.symbol and o.price is not None]:
            if (order.side == "buy" and order.price >= tick.price) or \
               (order.side == "sell" and order.price <= tick.price):
                self._fill(order, order.price)   # limit fills at its own price
                touched = True
        if touched:
            self._emit_state(tick.symbol)

    # ------------------------------------------------------------------ #
    def _fill(self, order: Order, price: float) -> None:
        self._fill_seq += 1
        fill = Fill(id=self._fill_seq, order_id=order.id, symbol=order.symbol,
                    side=order.side, price=price, qty=order.qty, timestamp=self._now())
        self.fills.append(fill)
        order.status = "filled"
        self.orders.pop(order.id, None)
        self._apply_to_position(self._position(order.symbol), order.side, price, order.qty)
        self._pending.append({"type": "fill", "symbol": order.symbol, "data": fill.to_dict()})

    @staticmethod
    def _apply_to_position(pos: Position, side: str, price: float, qty: float) -> None:
        signed = qty if side == "buy" else -qty
        old = pos.qty
        new = old + signed
        if old == 0:
            pos.entry_price = price
        elif (old > 0) == (signed > 0):                 # adding to the position
            pos.entry_price = (pos.entry_price * abs(old) + price * abs(signed)) / abs(new)
        else:                                           # reducing / closing / flipping
            if abs(new) < 1e-9:
                closed = abs(old)                       # fully close the position
                new = 0.0
            else:
                closed = min(abs(signed), abs(old))
            direction = 1.0 if old > 0 else -1.0
            pos.realised_pnl += (price - pos.entry_price) * closed * direction
            if abs(signed) > abs(old):                  # flipped to the other side
                pos.entry_price = price
        pos.qty = 0.0 if abs(new) < 1e-9 else new
        if pos.qty == 0.0:
            pos.entry_price = 0.0

    # ------------------------------------------------------------------ #
    def unrealised_pnl(self, symbol: str, current_price: float) -> float:
        pos = self.positions.get(symbol)
        return pos.unrealised_pnl(current_price) if pos else 0.0

    def state(self) -> dict:
        return {
            "positions": [p.to_dict(self._last_price.get(p.symbol)) for p in self.positions.values()],
            "orders": [o.to_dict() for o in self.orders.values()],
            "fills": [f.to_dict() for f in self.fills[-200:]],
        }

    def position_messages(self) -> list[dict]:
        """A fresh position snapshot (with live unrealised PnL) for periodic streaming."""
        out = []
        for p in self.positions.values():
            out.append({
                "type": "position",
                "symbol": p.symbol,
                "data": [p.to_dict(self._last_price.get(p.symbol))]
            })
        return out
