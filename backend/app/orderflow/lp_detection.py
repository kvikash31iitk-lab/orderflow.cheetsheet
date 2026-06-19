"""Liquidity Provider (LP) detection — proprietary/experimental.

An LP print is large *passive* defense: huge volume + small candle body (price
pinned) + a dominant side that got absorbed.
    aggressive selling absorbed, price holds  -> passive buyers  -> SUPPORT (green LP @ low)
    aggressive buying  absorbed, price stalls  -> passive sellers -> RESISTANCE (red LP @ high)

Thresholds are exposed via the AD/LP research module so they can be tuned and
back-measured (win-rate / expectancy / MAE / MFE).
"""
from __future__ import annotations

from typing import Optional

from .models import FootprintCandle


def detect(
    candle: FootprintCandle,
    volume_threshold: float,
    max_body_fraction: float,
) -> tuple[bool, Optional[str], Optional[float]]:
    """Return (detected, side, price) where side is "support" | "resistance"."""
    if candle.total_volume < volume_threshold or volume_threshold <= 0:
        return False, None, None

    rng = candle.high - candle.low
    if rng <= 0:
        return False, None, None

    body = abs(candle.close - candle.open)
    if body > max_body_fraction * rng:
        return False, None, None

    # Dominant absorbed side decides support vs resistance.
    if candle.total_bid_volume >= candle.total_ask_volume:
        return True, "support", candle.low
    return True, "resistance", candle.high
