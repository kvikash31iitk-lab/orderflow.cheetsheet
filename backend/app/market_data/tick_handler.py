"""Tick normalisation + trade-side classification.

Primary rule (from the spec, requires top-of-book quote):
    price >= ask  -> BUY   (aggressive buyer lifted the offer)
    price <= bid  -> SELL  (aggressive seller hit the bid)

Fallback when the trade prints *between* the quotes, or quotes are missing,
is the Lee-Ready tick rule: uptick = BUY, downtick = SELL, repeat last on no change.
"""
from __future__ import annotations

from typing import Optional

from ..orderflow.models import Tick, TradeSide


def classify_side(
    price: float,
    bid: Optional[float],
    ask: Optional[float],
    last_price: Optional[float],
    last_side: TradeSide = TradeSide.NEUTRAL,
) -> TradeSide:
    """Classify aggressor side for a single trade print."""
    if ask is not None and price >= ask:
        return TradeSide.BUY
    if bid is not None and price <= bid:
        return TradeSide.SELL

    # between the quotes (or quotes unknown) -> tick rule
    if last_price is not None:
        if price > last_price:
            return TradeSide.BUY
        if price < last_price:
            return TradeSide.SELL
        return last_side  # unchanged price -> repeat previous classification
    return TradeSide.NEUTRAL



def coerce_feed_side(side: object) -> Optional[TradeSide]:
    """Convert vendor-provided aggressor side to our internal side enum.

    Databento trades/TBBO use Ask for a sell aggressor and Bid for a buy aggressor.
    If the feed leaves side unspecified, return None so the quote/tick-rule fallback
    below still preserves behaviour for older rows and non-DataBento sources.
    """
    if side is None:
        return None
    if isinstance(side, TradeSide):
        return side
    raw = str(side).strip().upper()
    if not raw:
        return None
    if raw in {"B", "BID", "BUY"} or raw.endswith(".BID"):
        return TradeSide.BUY
    if raw in {"A", "ASK", "SELL"} or raw.endswith(".ASK"):
        return TradeSide.SELL
    if raw in {"N", "NONE", "NEUTRAL"} or raw.endswith(".NONE"):
        return TradeSide.NEUTRAL
    return None

class TickHandler:
    """Stateful per-symbol classifier (keeps last price/side for the tick rule)."""

    def __init__(self) -> None:
        self._last_price: dict[str, float] = {}
        self._last_side: dict[str, TradeSide] = {}

    def normalise(
        self,
        symbol: str,
        timestamp: int,
        price: float,
        volume: float,
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        side: object = None,
    ) -> Tick:
        feed_side = coerce_feed_side(side)
        side = feed_side if feed_side is not None else classify_side(
            price, bid, ask,
            self._last_price.get(symbol),
            self._last_side.get(symbol, TradeSide.NEUTRAL),
        )
        self._last_price[symbol] = price
        self._last_side[symbol] = side
        return Tick(
            symbol=symbol,
            timestamp=timestamp,
            price=price,
            volume=volume,
            bid=bid,
            ask=ask,
            side=side,
        )
