"""Trade-outcome evaluator for SC1 candidates.

Entry is fixed market-on-confirmation with NO lookahead: long on a bull candidate, short
on a bear candidate, filled at the first tick AFTER the signal bar closes (fallbacks:
next bar open, then signal close — always labelled `entry_source`). Each candidate is
scored through four exit models (fixed SL/TP at 1.5R & 2R, trailing-after-1R, time exit,
opposite-signal exit). R is ATR-based (1R = stop_r * ATR at the signal bar). MAE/MFE are
measured over the actually-held candle path. Conservative default costs/slippage are
applied round-trip and reported, never hidden.
"""
from __future__ import annotations

import bisect
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

from .config import ExitConfig


@dataclass
class TradeOutcome:
    candidate_id: str
    candidate_class: str
    side: str                 # long | short
    signal_time: int
    entry_time: int
    entry_price: float
    entry_source: str         # tick | next_open | signal_close
    exit_model: str
    exit_time: int
    exit_price: float
    gross_points: float
    net_points: float
    r_multiple: float         # net R
    mae: float                # worst adverse excursion (price points, >=0)
    mfe: float                # best favourable excursion (price points, >=0)
    bars_held: int
    win: bool
    reason: str               # tp | sl | trail | time | opposite | session_end | timeout
    cost_points: float
    slippage_points: float

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("entry_price", "exit_price", "gross_points", "net_points", "r_multiple", "mae", "mfe", "cost_points", "slippage_points"):
            # coerce non-finite -> None so a bad/NaN stored price can never make the
            # response non-JSON-compliant (Starlette uses allow_nan=False -> 500 otherwise)
            d[k] = round(d[k], 4) if math.isfinite(d[k]) else None
        return d


def _session_key(t_ms: float) -> str:
    d = datetime.fromtimestamp((float(t_ms) + 23 * 3600 * 1000) / 1000.0, tz=timezone.utc)
    return f"{d.year}-{d.month}-{d.day}"


def resolve_entry(end_time: int, next_open: Optional[float], signal_close: float,
                  tick_ts: list[int], tick_px: list[float],
                  max_lag_ms: Optional[int] = None) -> tuple[float, int, str]:
    """First tick at/after the signal bar's close; else next bar open; else signal close.

    The first-tick fill is only accepted when it lands within `max_lag_ms` of the close
    (typically one bar's duration). Without that guard, a signal that closes just before a
    gap in the tick stream would be filled at the FIRST tick AFTER the gap — minutes/days
    later at a wildly different price — fabricating a huge bogus move. Beyond the lag we
    fall back to the next bar's open (always close to the real fill on a continuous feed).
    """
    if tick_ts:
        pos = bisect.bisect_left(tick_ts, end_time)
        if pos < len(tick_ts) and (max_lag_ms is None or (tick_ts[pos] - end_time) <= max_lag_ms):
            return float(tick_px[pos]), int(tick_ts[pos]), "tick"
    if next_open is not None:
        return float(next_open), int(end_time), "next_open"
    return float(signal_close), int(end_time), "signal_close"


def _excursions(side: str, entry: float, path: list[dict], upto_idx: int) -> tuple[float, float]:
    """MAE/MFE (>=0 points) over path[0..upto_idx] inclusive."""
    mfe = 0.0
    mae = 0.0
    for k in range(0, upto_idx + 1):
        hi, lo = path[k]["high"], path[k]["low"]
        if side == "long":
            mfe = max(mfe, hi - entry)
            mae = max(mae, entry - lo)
        else:
            mfe = max(mfe, entry - lo)
            mae = max(mae, hi - entry)
    return mae, mfe


# why a forward path ended -> the honest fallback exit reason when no model exit fired
_END_REASON = {"session": "session_end", "dataend": "data_end", "maxhold": "timeout"}


def _forward_path(candles: list[dict], entry_bar: int, max_bars: int, entry_session: str) -> tuple[list[dict], str]:
    """Bars strictly AFTER the signal bar, capped at max_bars and the session boundary.

    Returns (path, end_reason) where end_reason is 'session' (hit a new session),
    'dataend' (ran past the last stored candle — the trade is RIGHT-CENSORED, not a real
    exit) or 'maxhold' (hit the bar cap). Censored trades must be labelled honestly so the
    stats aren't biased by treating an unfinished trade as a completed one."""
    out: list[dict] = []
    n = len(candles)
    hard = entry_bar + 1 + max_bars
    end = min(hard, n)
    for j in range(entry_bar + 1, end):
        c = candles[j]
        if _session_key(c["startTime"]) != entry_session:
            return out, "session"
        out.append(c)
    return out, ("maxhold" if hard <= n else "dataend")


def _finish(cand, side, entry, entry_time, entry_src, model, signal_time, exit_px, exit_time,
            bars, reason, mae, mfe, risk, cfg: ExitConfig) -> TradeOutcome:
    gross = (exit_px - entry) if side == "long" else (entry - exit_px)
    net = gross - cfg.cost_points - cfg.slippage_points
    r = net / risk if risk > 0 else 0.0
    return TradeOutcome(
        candidate_id=cand["id"], candidate_class=cand["klass"], side=side,
        signal_time=int(signal_time), entry_time=int(entry_time), entry_price=entry, entry_source=entry_src,
        exit_model=model, exit_time=int(exit_time), exit_price=exit_px,
        gross_points=gross, net_points=net, r_multiple=r, mae=mae, mfe=mfe, bars_held=bars,
        win=net > 0, reason=reason, cost_points=cfg.cost_points, slippage_points=cfg.slippage_points,
    )


def evaluate_candidate(cand: dict, candles: list[dict], entry: float, entry_time: int, entry_src: str,
                       opposite_times: set[int], cfg: ExitConfig) -> list[TradeOutcome]:
    """Score one candidate through every exit model. `candles` is the full closed-bar list;
    `cand['barIndex']` is the signal bar; `cand['atr']` sizes R."""
    side = cand["side"]
    i = cand["barIndex"]
    risk = max(cfg.stop_r * float(cand.get("atr") or 0.0), 1e-9)
    entry_session = _session_key(candles[i]["startTime"])
    path, end_reason = _forward_path(candles, i, cfg.max_hold_bars, entry_session)
    fallback_reason = _END_REASON[end_reason]   # honest label for an unfinished trade
    out: list[TradeOutcome] = []
    sig_t = cand["startTime"]

    def fin(model, exit_px, exit_idx, reason):
        bars = exit_idx + 1
        mae, mfe = _excursions(side, entry, path, exit_idx)
        return _finish(cand, side, entry, entry_time, entry_src, model, sig_t,
                       exit_px, path[exit_idx]["startTime"], bars, reason, mae, mfe, risk, cfg)

    if not path:
        return out

    # ---- fixed SL/TP (per target) ----
    for k in cfg.targets_r:
        if side == "long":
            sl, tp = entry - risk, entry + k * risk
        else:
            sl, tp = entry + risk, entry - k * risk
        done = False
        for idx, c in enumerate(path):
            hit_sl = c["low"] <= sl if side == "long" else c["high"] >= sl
            hit_tp = c["high"] >= tp if side == "long" else c["low"] <= tp
            if hit_sl and hit_tp:
                out.append(fin(f"fixed_{k:g}R", sl, idx, "sl")); done = True; break  # conservative: SL first
            if hit_sl:
                out.append(fin(f"fixed_{k:g}R", sl, idx, "sl")); done = True; break
            if hit_tp:
                out.append(fin(f"fixed_{k:g}R", tp, idx, "tp")); done = True; break
        if not done:
            last = len(path) - 1
            out.append(fin(f"fixed_{k:g}R", path[last]["close"], last, fallback_reason))

    # ---- trailing stop (engages after +activate R) ----
    # NO intrabar lookahead: each bar is first tested against the stop carried from PRIOR
    # bars, THEN this bar's extreme arms/ratchets the stop for subsequent bars. (Testing
    # against a stop ratcheted by the same bar's own high/low would assume the high printed
    # before the low and overstate trailing performance.)
    stop = entry - risk if side == "long" else entry + risk
    armed = False
    extreme = entry
    trail_done = False
    for idx, c in enumerate(path):
        if side == "long":
            if c["low"] <= stop:
                out.append(fin("trailing", stop, idx, "trail" if armed else "sl")); trail_done = True; break
            extreme = max(extreme, c["high"])
            if not armed and (c["high"] - entry) >= cfg.trail_activate_r * risk:
                armed = True
            if armed:
                stop = max(stop, extreme - cfg.trail_atr_mult * risk)
        else:
            if c["high"] >= stop:
                out.append(fin("trailing", stop, idx, "trail" if armed else "sl")); trail_done = True; break
            extreme = min(extreme, c["low"])
            if not armed and (entry - c["low"]) >= cfg.trail_activate_r * risk:
                armed = True
            if armed:
                stop = min(stop, extreme + cfg.trail_atr_mult * risk)
    if not trail_done:
        last = len(path) - 1
        out.append(fin("trailing", path[last]["close"], last, fallback_reason))

    # ---- time exit ----
    t_idx = min(cfg.time_exit_bars - 1, len(path) - 1)
    t_reason = "time" if (cfg.time_exit_bars - 1) <= (len(path) - 1) else fallback_reason
    out.append(fin("time", path[t_idx]["close"], t_idx, t_reason))

    # ---- opposite-signal exit ----
    opp_idx = None
    for idx, c in enumerate(path):
        if int(c["startTime"]) in opposite_times:
            opp_idx = idx
            break
    if opp_idx is not None:
        out.append(fin("opposite", path[opp_idx]["close"], opp_idx, "opposite"))
    else:
        last = len(path) - 1
        out.append(fin("opposite", path[last]["close"], last, fallback_reason))

    return out
