"""OrderFlowEngine — runs every detector over a candle with rolling state.

One engine instance per (symbol, timeframe). The aggregator calls:
    engine.analyze(candle, commit=False)  # on every tick update of the open candle
    engine.analyze(candle, commit=True)   # once, when the candle closes

`commit=True` advances cumulative delta and the rolling statistics windows;
`commit=False` is an idempotent preview so the live candle shows signals too.
"""
from __future__ import annotations

from collections import deque
from typing import Optional

import numpy as np

from ..config import Settings, settings as default_settings
from . import absorption, ad_detection, exhaustion, imbalance, lp_detection
from .delta import is_delta_spike
from .market_structure import MarketStructure
from .models import FootprintCandle


class OrderFlowEngine:
    def __init__(
        self,
        symbol: str,
        timeframe: str,
        cfg: Optional[Settings] = None,
        history: int = 200,
    ) -> None:
        self.symbol = symbol
        self.timeframe = timeframe
        self.cfg = cfg or default_settings

        self.cum_delta: float = 0.0
        self._volumes: deque[float] = deque(maxlen=history)
        self._abs_deltas: deque[float] = deque(maxlen=history)
        self._highs: deque[float] = deque(maxlen=50)
        self._lows: deque[float] = deque(maxlen=50)
        self._structure = MarketStructure()
        # stateful horizontal stacked-imbalance zones (created + mitigated over time)
        self.active_zones: list[dict] = []
        # frozen snapshot of active_zones, rebuilt only on commit (cheap to share
        # by reference with every live tick — avoids per-tick copying).
        self._zone_snapshot: list[dict] = []

    # ------------------------------------------------------------------ #
    def analyze(self, candle: FootprintCandle, commit: bool, light: bool | None = None) -> FootprintCandle:
        """Run detectors over a candle.

        light=True  -> cheap path for the live (in-progress) candle: delta,
                       cumulative delta, imbalance highlighting, volume nodes.
        light=False -> full path incl. the numpy/percentile detectors (absorption,
                       LP, AD, exhaustion, volume spike/cluster). Always run on commit.
        Defaults to light = not commit, so heavy stats are computed once per bar
        (at close) instead of on every tick — the throughput-critical optimisation.
        """
        cfg = self.cfg
        if light is None:
            light = not commit

        candle.cum_delta = self.cum_delta + candle.delta

        # --- imbalance + stacked imbalance (always, cheap) ---
        imbalance.flag_imbalances(candle, cfg.imbalance_ratio, cfg.imbalance_min_volume)
        candle.signals.stacked_imbalances = imbalance.find_stacked(
            candle, cfg.stacked_imbalance_count
        )

        # --- volume nodes within the candle (per price row, cheap) ---
        self._volume_nodes(candle)

        if not light:
            self._heavy_detectors(candle)

        # --- commit: advance running state once the candle is final ---
        if commit:
            self.cum_delta += candle.delta
            self._volumes.append(candle.total_volume)
            self._abs_deltas.append(abs(candle.delta))
            candle.market_structure = self._structure.update(candle.high, candle.low) \
                or self._structure.last_label
            self._highs.append(candle.high)
            self._lows.append(candle.low)
            self._update_active_zones(candle)
            candle.closed = True
        else:
            candle.market_structure = self._structure.last_label

        # expose the current zone state on every candle (live + closed) so the
        # frontend can draw horizontal bands. The snapshot is a list of frozen
        # copies rebuilt only on commit, so live ticks just share it by reference
        # and later mitigation never mutates an already-serialised candle.
        candle.signals.active_zones = self._zone_snapshot

        return candle

    # ------------------------------------------------------------------ #
    def _update_active_zones(self, candle: FootprintCandle) -> None:
        """Register this candle's new stacked-imbalance zones and mitigate old ones.

        Mitigation: a bullish zone is mitigated once price trades below its
        start_price; a bearish zone once price trades above its end_price.
        """
        # 1) register newly formed zones from the just-closed candle
        for z in candle.signals.stacked_imbalances:
            self.active_zones.append({
                "direction": z.direction,
                "start_price": z.start_price,
                "end_price": z.end_price,
                "start_time": candle.start_time,
                "mitigated": False,
                "mitigation_time": None,
            })

        # 2) evaluate older unmitigated zones against this candle's range
        for z in self.active_zones:
            if z["mitigated"] or z["start_time"] == candle.start_time:
                continue
            if z["direction"] == "bullish" and candle.low < z["start_price"]:
                z["mitigated"], z["mitigation_time"] = True, candle.start_time
            elif z["direction"] == "bearish" and candle.high > z["end_price"]:
                z["mitigated"], z["mitigation_time"] = True, candle.start_time

        # 3) bound memory: keep all unmitigated zones + the most recent mitigated
        mitigated = [z for z in self.active_zones if z["mitigated"]]
        if len(mitigated) > 50:
            keep = {id(z) for z in mitigated[-50:]}
            self.active_zones = [
                z for z in self.active_zones if (not z["mitigated"]) or id(z) in keep
            ]

        # rebuild the frozen snapshot once per commit (frozen copies so live ticks
        # can share it without per-tick allocation)
        self._zone_snapshot = [dict(z) for z in self.active_zones]

    # ------------------------------------------------------------------ #
    def _heavy_detectors(self, candle: FootprintCandle) -> None:
        """Percentile/std based detectors — run once per bar (at close)."""
        cfg = self.cfg
        # --- rolling stats from prior closed candles ---
        volumes = np.asarray(self._volumes, dtype=float)
        v_mean = float(volumes.mean()) if volumes.size else 0.0
        v_std = float(volumes.std()) if volumes.size > 1 else 0.0
        abs_deltas = list(self._abs_deltas)

        # volume spike + cluster (candle-level)
        if volumes.size >= 5:
            vp = float(np.percentile(volumes, cfg.volume_cluster_percentile))
            candle.signals.volume_cluster = candle.total_volume >= vp > 0
            candle.signals.volume_spike = candle.total_volume >= (v_mean + 2 * v_std) and v_std > 0

        # absorption
        if v_std > 0:
            vol_thr = v_mean + cfg.absorption_volume_std * v_std
            max_range = cfg.absorption_max_range_ticks * candle.row_size
            det, side, price = absorption.detect(candle, vol_thr, max_range)
            candle.signals.absorption = det
            candle.signals.absorption_side = side
            candle.signals.absorption_price = price

            # LP
            lp_thr = v_mean + cfg.lp_volume_std * v_std
            ld, lside, lprice = lp_detection.detect(candle, lp_thr, cfg.lp_max_body_fraction)
            candle.signals.lp = ld
            candle.signals.lp_side = lside
            candle.signals.lp_price = lprice

        # exhaustion (vs rolling extremes, excluding current)
        prev_high = max(self._highs) if self._highs else None
        prev_low = min(self._lows) if self._lows else None
        ed, etype = exhaustion.detect(candle, prev_high, prev_low, cfg.exhaustion_volume_fraction)
        candle.signals.exhaustion = ed
        candle.signals.exhaustion_type = etype

        # AD + delta spike
        ad_det, ad_val = ad_detection.detect(candle, abs_deltas, cfg.ad_delta_percentile)
        candle.signals.ad = ad_det
        candle.signals.ad_value = ad_val
        candle.signals.delta_spike = is_delta_spike(
            candle.delta, abs_deltas, cfg.ad_delta_percentile
        )

        # delta divergence vs the last 5 closed candles (current excluded, since
        # _heavy_detectors runs before the commit block appends to the deques):
        #   bullish: new local low but POSITIVE delta (selling not confirmed)
        #   bearish: new local high but NEGATIVE delta (buying not confirmed)
        candle.signals.delta_divergence = False
        candle.signals.delta_divergence_side = None
        recent_lows = list(self._lows)[-5:]
        recent_highs = list(self._highs)[-5:]
        if recent_lows and candle.low < min(recent_lows) and candle.delta > 0:
            candle.signals.delta_divergence = True
            candle.signals.delta_divergence_side = "bullish"
        elif recent_highs and candle.high > max(recent_highs) and candle.delta < 0:
            candle.signals.delta_divergence = True
            candle.signals.delta_divergence_side = "bearish"

    # ------------------------------------------------------------------ #
    def _volume_nodes(self, candle: FootprintCandle) -> None:
        """High/Low Volume Nodes from per-row totals: total > mean+2σ / < mean-2σ."""
        totals = np.asarray([c.total for c in candle.cells.values()], dtype=float)
        candle.signals.hvn = []
        candle.signals.lvn = []
        if totals.size < 3:
            return
        mean = float(totals.mean())
        std = float(totals.std())
        if std <= 0:
            return
        hi = mean + 2 * std
        lo = mean - 2 * std
        for cell in candle.cells.values():
            if cell.total > hi:
                candle.signals.hvn.append(cell.price)
            elif cell.total < lo:
                candle.signals.lvn.append(cell.price)

    @property
    def trend(self) -> str:
        return self._structure.trend
