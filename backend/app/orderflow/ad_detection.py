"""Aggressive Delta (AD) detection — proprietary/experimental.

AD fires when a candle's |delta| is an outlier vs recent history: a burst of
one-sided aggression. Implemented as a rolling-percentile test on |delta|.
"""
from __future__ import annotations

import numpy as np

from .models import FootprintCandle


def detect(
    candle: FootprintCandle,
    recent_abs_deltas: list[float],
    percentile: float,
) -> tuple[bool, float]:
    """Return (detected, delta_value).

    `recent_abs_deltas` are |delta| of prior closed candles (current excluded).
    """
    delta = candle.delta
    if len(recent_abs_deltas) < 5:
        return False, delta

    threshold = float(np.percentile(recent_abs_deltas, percentile))
    if threshold <= 0:
        return False, delta
    return abs(delta) >= threshold, delta
