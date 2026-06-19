"""Absorption: heavy volume traded while price barely moves.

Large aggressive flow hits the book but price is pinned -> a passive participant
absorbed the orders. Side is inferred from net delta:
    delta > 0 (net buying absorbed)  -> passive sellers defending -> side "ask"
    delta < 0 (net selling absorbed) -> passive buyers defending  -> side "bid"
"""
from __future__ import annotations

from typing import Optional

from .models import FootprintCandle


def detect(
    candle: FootprintCandle,
    volume_threshold: float,
    max_range_price: float,
) -> tuple[bool, Optional[str], Optional[float]]:
    """Return (detected, side, price)."""
    if candle.total_volume < volume_threshold or volume_threshold <= 0:
        return False, None, None

    price_range = candle.high - candle.low
    if price_range > max_range_price:
        return False, None, None

    side = "ask" if candle.delta > 0 else "bid"
    return True, side, candle.poc
