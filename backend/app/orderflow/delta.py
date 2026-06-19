"""Delta + cumulative delta helpers.

Per-candle delta = total_ask_volume - total_bid_volume (a property on the candle).
This module provides the running cumulative series and a delta-spike test used by
the engine and the delta-histogram widget.
"""
from __future__ import annotations

from collections.abc import Iterable

from .models import FootprintCandle


def cumulative_delta(candles: Iterable[FootprintCandle], start: float = 0.0) -> list[float]:
    """Running total of per-candle delta. Mirrors what the engine maintains live."""
    running = start
    out: list[float] = []
    for c in candles:
        running += c.delta
        out.append(running)
    return out


def is_delta_spike(delta: float, recent_abs_deltas: list[float], percentile: float) -> bool:
    """True when |delta| exceeds the given percentile of recent |delta| values."""
    if len(recent_abs_deltas) < 5:
        return False
    import numpy as np

    threshold = float(np.percentile(recent_abs_deltas, percentile))
    return abs(delta) >= threshold and threshold > 0
