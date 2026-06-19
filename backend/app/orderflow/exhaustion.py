"""Exhaustion: price extends to a new extreme but driving-side volume dries up.

new high + thin ask volume at the top  -> buyers exhausted (potential top)
new low  + thin bid volume at the bottom -> sellers exhausted (potential bottom)
"""
from __future__ import annotations

from typing import Optional

from .models import FootprintCandle


def detect(
    candle: FootprintCandle,
    prev_high: Optional[float],
    prev_low: Optional[float],
    fraction: float,
) -> tuple[bool, Optional[str]]:
    """Return (detected, type) where type is "high" | "low" | None."""
    if not candle.cells:
        return False, None

    avg_cell_total = candle.total_volume / max(len(candle.cells), 1)
    if avg_cell_total <= 0:
        return False, None

    rows = sorted(candle.cells.keys())
    top_cell = candle.cells[rows[-1]]
    bottom_cell = candle.cells[rows[0]]

    made_high = prev_high is None or candle.high > prev_high
    made_low = prev_low is None or candle.low < prev_low

    if made_high and top_cell.ask_volume < fraction * avg_cell_total:
        return True, "high"
    if made_low and bottom_cell.bid_volume < fraction * avg_cell_total:
        return True, "low"
    return False, None
