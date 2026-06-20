"""SC1 research configuration.

`Sc1Config` carries the SC1 V4 Indicator-1 parameters (defaults == the live indicator's
defaults — see frontend/src/indicators/sc1_1604_v3.ts inputs), PLUS research-only knobs
(near-miss margins, costs/slippage, exit-model settings). It is a plain dataclass so a
sweep can clone it with `replace()`; `config_hash()` gives a short stable id per config.

This NEVER mutates the live indicator — it is a parallel, deterministic re-implementation
of Indicator 1 (which is what drives the SC1 super signal) for offline analysis.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, replace


@dataclass
class Sc1Config:
    # ---- Indicator 1 core (defaults mirror the live SC1 V4) ----
    i1_lookback: int = 8
    i1_volLength: int = 12
    i1_rsiLength: int = 7
    i1_atrLength: int = 14
    i1_swingAtrMult: float = 0.25
    i1_weakVol: float = 0.90
    i1_absorpDeltaPct: float = 8.0
    i1_trapDeltaMult: float = 0.18
    i1_minStrength: float = 45.0
    i1_netEdgeSignalThreshold: float = 60.0
    i1_useConfirm: bool = False
    # liquidity sweep
    i1_useLiquiditySweep: bool = True
    i1_lsPivotLeft: int = 3
    i1_lsPivotRight: int = 3
    i1_lsMinSweepAtr: float = 0.10
    i1_lsMaxAgeBars: int = 50
    i1_lsRequireCloseBackIn: bool = True
    i1_lsVolumeMult: float = 0.80
    i1_lsWeight: float = 15.0
    # trend filters
    i1_useTrendRegimeFilter: bool = True
    i1_htfEmaLength: int = 50
    i1_adxLength: int = 14
    i1_adxSmoothing: int = 14
    i1_adxTrendThreshold: float = 28.0
    i1_useReclaimFilter: bool = True
    i1_trendEmaLength: int = 20
    i1_useStructureBreakFilter: bool = True
    i1_structureMaxAgeBars: int = 40
    i1_trendPenaltyWeight: float = 16.0
    i1_reclaimReliefWeight: float = 6.0
    i1_structureReliefWeight: float = 8.0
    i1_softMissingPenalty: float = 2.0
    i1_trendAlignedBonusWeight: float = 3.0
    # signal candle filter (doji / hammer / shooting-star)
    i1_useSignalCandleFilter: bool = True
    i1_dojiMaxBodyRange: float = 0.12
    i1_hammerMinWickBody: float = 1.8
    i1_hammerMaxOppositeWickBody: float = 0.8
    # super signal
    skipConflictingBars: bool = True
    cooldownBars: int = 0

    # ---- 5-second lower-timeframe orderflow (V4) ----
    use5sOrderflow: bool = True
    min5sCoverage: float = 0.70
    htfTimeframe: str = "15m"

    # ---- research-only knobs (NOT part of the indicator) ----
    # a "near miss" is a non-firing bar whose strength/net-edge is within these
    # margins of the thresholds (would have fired if thresholds were this much looser).
    nearMissStrengthMargin: float = 8.0
    nearMissNetEdgeMargin: float = 12.0

    def clone(self, **overrides) -> "Sc1Config":
        return replace(self, **overrides)

    def to_dict(self) -> dict:
        return asdict(self)

    def config_hash(self) -> str:
        blob = json.dumps(asdict(self), sort_keys=True).encode()
        return hashlib.sha1(blob).hexdigest()[:10]


@dataclass
class ExitConfig:
    """Exit-model + cost assumptions for outcome scoring. R is ATR-based by default."""
    atr_length: int = 14            # ATR used to size 1R (matches i1_atrLength)
    stop_r: float = 1.0             # initial stop = 1R from entry
    targets_r: list[float] = field(default_factory=lambda: [1.5, 2.0])
    trail_activate_r: float = 1.0   # trailing engages after +1R
    trail_atr_mult: float = 1.0     # trail distance = trail_atr_mult * ATR
    time_exit_bars: int = 20        # bars-held cap for the time-exit model
    max_hold_bars: int = 120        # hard cap for every model (safety / session-ish)
    # costs are CONSERVATIVE DEFAULTS and clearly labelled (GC has no stored cost cfg).
    # round-trip cost in PRICE points (entry+exit), applied against gross.
    cost_points: float = 0.20       # ~2 ticks GC ($0.10/tick) round trip — DEFAULT, tune.
    slippage_points: float = 0.10   # extra adverse fill on entry+exit — DEFAULT, tune.

    def to_dict(self) -> dict:
        return asdict(self)
