"""Market structure: label swing pivots as HH / HL / LH / LL and derive trend.

A simple 3-candle fractal pivot detector. When the *middle* of the last three
closed candles is a local high (or low), it is confirmed as a swing point and
compared against the previous swing of the same kind.
"""
from __future__ import annotations

from collections import deque
from typing import Optional


class MarketStructure:
    def __init__(self) -> None:
        self._highs: deque[float] = deque(maxlen=3)
        self._lows: deque[float] = deque(maxlen=3)
        self._last_swing_high: Optional[float] = None
        self._last_swing_low: Optional[float] = None
        self.last_label: Optional[str] = None       # HH | HL | LH | LL
        self.trend: str = "neutral"                  # up | down | neutral

    def update(self, high: float, low: float) -> Optional[str]:
        """Feed one closed candle's high/low; return a swing label if confirmed."""
        self._highs.append(high)
        self._lows.append(low)
        if len(self._highs) < 3:
            return None

        h0, h1, h2 = self._highs
        l0, l1, l2 = self._lows
        label: Optional[str] = None

        # swing high = middle high strictly above both neighbours
        if h1 > h0 and h1 > h2:
            if self._last_swing_high is None or h1 > self._last_swing_high:
                label = "HH"
            else:
                label = "LH"
            self._last_swing_high = h1

        # swing low = middle low strictly below both neighbours
        if l1 < l0 and l1 < l2:
            low_label = "LL" if (self._last_swing_low is not None and l1 < self._last_swing_low) else "HL"
            if self._last_swing_low is None:
                low_label = "HL"
            # prefer the freshest confirmation if both fired
            label = low_label if label is None else label
            self._last_swing_low = l1

        if label is not None:
            self.last_label = label
            if label in ("HH", "HL"):
                self.trend = "up"
            elif label in ("LL", "LH"):
                self.trend = "down"
        return label
