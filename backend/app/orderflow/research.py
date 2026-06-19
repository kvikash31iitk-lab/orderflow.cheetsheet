"""AD / LP research + signal-validation module.

Because AD and LP are proprietary/experimental, this module lets you:
  * tune thresholds (sensitivity) by re-running the engine over recorded candles,
  * validate every signal occurrence against the subsequent price path,
  * measure win-rate, expectancy, MAE (max adverse excursion) and
    MFE (max favourable excursion).

It is intentionally dependency-light (pure python) so it can run in notebooks,
tests, or a CLI sweep over data pulled from Postgres.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from statistics import mean
from typing import Iterable, Optional

from ..config import Settings, settings as default_settings
from .engine import OrderFlowEngine
from .models import FootprintCandle


@dataclass
class SignalOutcome:
    start_time: int
    side: str                 # "long" | "short"
    entry: float
    mae: float                # worst excursion against the trade (price units)
    mfe: float                # best excursion in favour (price units)
    ret: float                # signed return at the horizon
    win: bool
    end_time: int = 0         # epoch ms of the exit (horizon) candle
    exit_price: float = 0.0   # close of the exit candle


@dataclass
class ResearchReport:
    label: str
    n: int = 0
    win_rate: float = 0.0
    expectancy: float = 0.0   # mean signed return per signal
    avg_mae: float = 0.0
    avg_mfe: float = 0.0
    outcomes: list[SignalOutcome] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "label": self.label, "n": self.n, "winRate": round(self.win_rate, 4),
            "expectancy": round(self.expectancy, 4), "avgMae": round(self.avg_mae, 4),
            "avgMfe": round(self.avg_mfe, 4),
            "outcomes": [
                {
                    "startTime": o.start_time,
                    "side": o.side,
                    "entry": round(o.entry, 4),
                    "mae": round(o.mae, 4),
                    "mfe": round(o.mfe, 4),
                    "ret": round(o.ret, 4),
                    "win": o.win,
                    "endTime": o.end_time,
                    "exitPrice": round(o.exit_price, 4),
                }
                for o in self.outcomes
            ],
        }


def evaluate_signal(entry: float, side: str, forward_closes: list[float]) -> Optional[SignalOutcome]:
    """Measure MAE/MFE/return of one signal over the next N candle closes."""
    if not forward_closes:
        return None
    long = side == "long"
    mfe = 0.0
    mae = 0.0
    for px in forward_closes:
        move = (px - entry) if long else (entry - px)
        mfe = max(mfe, move)
        mae = min(mae, move)
    ret = (forward_closes[-1] - entry) if long else (entry - forward_closes[-1])
    return SignalOutcome(0, side, entry, abs(mae), mfe, ret, ret > 0)


# signal label -> implied trade direction for validation
_SIDE_FROM_SIGNAL = {
    "AD_BULL": "long", "AD_BEAR": "short",
    "LP_support": "long", "LP_resistance": "short",
    "ABSORPTION_bid": "long", "ABSORPTION_ask": "short",
    "EXHAUSTION_low": "long", "EXHAUSTION_high": "short",
}


def _signal_side(candle: FootprintCandle, kind: str) -> Optional[str]:
    s = candle.signals
    if kind == "AD" and s.ad:
        return "long" if s.ad_value > 0 else "short"
    if kind == "LP" and s.lp:
        return _SIDE_FROM_SIGNAL.get(f"LP_{s.lp_side}")
    if kind == "ABSORPTION" and s.absorption:
        return _SIDE_FROM_SIGNAL.get(f"ABSORPTION_{s.absorption_side}")
    if kind == "EXHAUSTION" and s.exhaustion:
        return _SIDE_FROM_SIGNAL.get(f"EXHAUSTION_{s.exhaustion_type}")
    return None


def validate(candles: list[FootprintCandle], kind: str, horizon: int = 5, label: str = "") -> ResearchReport:
    """Walk closed candles; for every `kind` signal, score it over `horizon` bars."""
    rep = ResearchReport(label=label or kind)
    for i, c in enumerate(candles):
        side = _signal_side(c, kind)
        if side is None:
            continue
        fwd = [candles[j].close for j in range(i + 1, min(i + 1 + horizon, len(candles)))]
        out = evaluate_signal(c.close, side, fwd)
        if out is None:
            continue
        out.start_time = c.start_time
        # exit candle = last one in the forward window
        exit_idx = min(i + len(fwd), len(candles) - 1)
        out.end_time = candles[exit_idx].start_time
        out.exit_price = candles[exit_idx].close
        rep.outcomes.append(out)
    if rep.outcomes:
        rep.n = len(rep.outcomes)
        rep.win_rate = sum(o.win for o in rep.outcomes) / rep.n
        rep.expectancy = mean(o.ret for o in rep.outcomes)
        rep.avg_mae = mean(o.mae for o in rep.outcomes)
        rep.avg_mfe = mean(o.mfe for o in rep.outcomes)
    return rep


def replay_with_settings(
    candles: Iterable[FootprintCandle],
    overrides: dict,
    symbol: str = "X",
    timeframe: str = "1m",
    base: Optional[Settings] = None,
) -> list[FootprintCandle]:
    """Re-run the engine over recorded candles with tuned thresholds.

    `candles` should be raw (cells populated) but un-analysed; returns analysed
    deep copies so the originals are untouched (safe for parameter sweeps).
    """
    cfg = (base or default_settings).model_copy(update=overrides)
    eng = OrderFlowEngine(symbol, timeframe, cfg)
    out: list[FootprintCandle] = []
    for c in candles:
        cc = copy.deepcopy(c)
        cc.signals = type(cc.signals)()
        eng.analyze(cc, commit=True)
        out.append(cc)
    return out


def sweep(
    candles: list[FootprintCandle],
    kind: str,
    grid: dict[str, list],
    horizon: int = 5,
) -> list[ResearchReport]:
    """Grid-search one or more threshold params; return a report per combo,
    sorted by expectancy. `grid` maps a Settings field name to candidate values.
    """
    keys = list(grid)
    combos: list[dict] = [{}]
    for k in keys:
        combos = [{**c, k: v} for c in combos for v in grid[k]]

    reports: list[ResearchReport] = []
    for combo in combos:
        analysed = replay_with_settings(candles, combo)
        label = ", ".join(f"{k}={v}" for k, v in combo.items())
        reports.append(validate(analysed, kind, horizon=horizon, label=label))
    reports.sort(key=lambda r: r.expectancy, reverse=True)
    return reports
