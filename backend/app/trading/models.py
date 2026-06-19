"""Data models for the simulated broker (paper trading only)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(slots=True)
class Order:
    id: int
    symbol: str
    side: str                 # "buy" | "sell"
    type: str                 # "market" | "limit"
    qty: float
    price: Optional[float] = None   # limit price (None for market)
    status: str = "working"   # "working" | "filled" | "cancelled"
    timestamp: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id, "symbol": self.symbol, "side": self.side, "type": self.type,
            "qty": self.qty, "price": self.price, "status": self.status, "timestamp": self.timestamp,
        }


@dataclass(slots=True)
class Fill:
    id: int
    order_id: int
    symbol: str
    side: str                 # "buy" | "sell"
    price: float
    qty: float
    timestamp: int

    def to_dict(self) -> dict:
        return {
            "id": self.id, "orderId": self.order_id, "symbol": self.symbol, "side": self.side,
            "price": self.price, "qty": self.qty, "timestamp": self.timestamp,
        }


@dataclass(slots=True)
class Position:
    """Net position. qty is signed: +long, -short, 0 flat."""
    symbol: str
    qty: float = 0.0
    entry_price: float = 0.0      # average entry of the open qty
    realised_pnl: float = 0.0

    def unrealised_pnl(self, current_price: Optional[float]) -> float:
        if not self.qty or current_price is None:
            return 0.0
        return (current_price - self.entry_price) * self.qty

    def to_dict(self, current_price: Optional[float] = None) -> dict:
        return {
            "symbol": self.symbol,
            "qty": self.qty,
            "entryPrice": self.entry_price if self.qty else None,
            "realisedPnl": self.realised_pnl,
            "unrealisedPnl": self.unrealised_pnl(current_price),
        }
