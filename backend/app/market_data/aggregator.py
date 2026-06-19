"""Time/tick bucketing of ticks into analysed footprint candles.

`Aggregator`        -> one (symbol, timeframe); owns an OrderFlowEngine.
`AggregatorManager` -> fans one tick out to every active timeframe of a symbol.

`add_tick` is synchronous and returns events; the async caller (main pipeline)
is responsible for persistence + broadcasting so the hot path never blocks on IO.
"""
from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Optional

from ..config import TIMEFRAME_MINUTES, Settings, settings as default_settings
from ..orderflow import imbalance
from ..orderflow.engine import OrderFlowEngine
from ..orderflow.footprint import add_tick as fold_tick, price_to_row
from ..orderflow.models import FootprintCandle, FootprintCell, Tick

# Per-symbol order-flow tuning. Single source of truth for the footprint row size
# (price granularity) AND the imbalance / volume thresholds the FRONTEND renderer
# uses to colour cells. Exposed via /api/symbol-config so the UI reads the same
# numbers. Tuning is empirical — tweak here (no rebuild needed for the frontend,
# which fetches it at runtime):
#   row_size              -> footprint price-row granularity (authoritative)
#   imbalance_ratio       -> ask/bid (or bid/ask) ratio to flag a cell imbalance
#   min_vol_for_highlight -> minimum cell volume before an imbalance is highlighted
#   stacked_imbalance_min -> consecutive imbalanced rows to mark a stacked zone
#   currency / tick_value -> display metadata (cash value per tick per contract)
SYMBOL_CONFIG: dict[str, dict] = {
    # --- NSE India Futures (TrueData) ---
    "NIFTY-I":      {"row_size": 0.1,  "imbalance_ratio": 3.0, "min_vol_for_highlight": 100, "stacked_imbalance_min": 2, "currency": "INR", "tick_value": 1.0},
    "BANKNIFTY-I":  {"row_size": 0.2,  "imbalance_ratio": 3.0, "min_vol_for_highlight": 50,  "stacked_imbalance_min": 2, "currency": "INR", "tick_value": 1.0},
    "FINNIFTY-I":   {"row_size": 5.0,  "imbalance_ratio": 3.0, "min_vol_for_highlight": 30,  "stacked_imbalance_min": 2, "currency": "INR", "tick_value": 1.0},
    "MIDCPNIFTY-I": {"row_size": 5.0,  "imbalance_ratio": 3.0, "min_vol_for_highlight": 30,  "stacked_imbalance_min": 2, "currency": "INR", "tick_value": 1.0},
    "SENSEX-I":     {"row_size": 10.0, "imbalance_ratio": 3.0, "min_vol_for_highlight": 30,  "stacked_imbalance_min": 2, "currency": "INR", "tick_value": 1.0},
    # --- CME Globex Futures (DataBento, GLBX.MDP3, volume-roll continuous) ---
    # 6E: Euro FX futures. 1 tick = 0.00005 USD/EUR = $6.25 per contract.
    # .v.0 = volume-roll: tracks the most liquid quarterly (e.g. 6EU6 Sep).
    "6E.V.0":       {"row_size": 0.00005, "imbalance_ratio": 2.5, "min_vol_for_highlight": 3,   "stacked_imbalance_min": 3, "currency": "USD", "tick_value": 6.25},
    # GC: Gold futures (COMEX). 1 tick = $0.10/troy oz = $10 per contract (100 oz).
    # .v.0 = volume-roll: tracks the active front month (e.g. GCQ6 Aug when Jun expires).
    "GC.V.0":       {"row_size": 0.10,    "imbalance_ratio": 2.5, "min_vol_for_highlight": 3,   "stacked_imbalance_min": 3, "currency": "USD", "tick_value": 10.00},
    # --- US Equities (DataBento, DBEQ.BASIC) ---
    "AAPL":         {"row_size": 0.01, "imbalance_ratio": 2.0, "min_vol_for_highlight": 50,  "stacked_imbalance_min": 2, "currency": "USD", "tick_value": 0.01},
    "MSFT":         {"row_size": 0.01, "imbalance_ratio": 2.0, "min_vol_for_highlight": 50,  "stacked_imbalance_min": 2, "currency": "USD", "tick_value": 0.01},
}

# Footprint row size (price granularity) per instrument — DERIVED from SYMBOL_CONFIG
# so the two can never drift. Unknown symbols fall back to DEFAULT_ROW_SIZE.
SYMBOL_ROW_SIZE: dict[str, float] = {k: v["row_size"] for k, v in SYMBOL_CONFIG.items()}
DEFAULT_ROW_SIZE = 1.0
# Ticks per bar when timeframe == "tick".
TICK_BAR_SIZE = 200


def default_row_size(symbol: str) -> float:
    return SYMBOL_ROW_SIZE.get(symbol.upper(), DEFAULT_ROW_SIZE)


def get_symbol_config(symbol: str) -> dict:
    """Per-symbol order-flow tuning (returns a copy, safe to mutate).

    Known symbols return their SYMBOL_CONFIG entry. Unknown symbols get a config
    synthesised from the global engine defaults plus the *authoritative* row size,
    so `row_size` always equals default_row_size(symbol) (no 0.1-vs-1.0 surprise).
    Casing/continuous form is normalised via .upper() (e.g. ES.c.0 -> ES.C.0).
    """
    cfg = SYMBOL_CONFIG.get(symbol.upper())
    if cfg is not None:
        return dict(cfg)
    return {
        "row_size": default_row_size(symbol),
        "imbalance_ratio": float(default_settings.imbalance_ratio),
        "min_vol_for_highlight": int(default_settings.imbalance_min_volume),
        "stacked_imbalance_min": int(default_settings.stacked_imbalance_count),
        "currency": "USD",
        "tick_value": default_row_size(symbol),
    }


@dataclass
class CandleEvent:
    timeframe: str
    live: FootprintCandle              # the (updated) currently-open candle
    closed: Optional[FootprintCandle]  # set only on the tick that closed a bar


class Aggregator:
    def __init__(
        self,
        symbol: str,
        timeframe: str,
        row_size: Optional[float] = None,
        cfg: Optional[Settings] = None,
    ) -> None:
        if timeframe not in TIMEFRAME_MINUTES:
            raise ValueError(f"unknown timeframe {timeframe!r}")
        self.cfg = cfg or default_settings
        self.symbol = symbol
        self.timeframe = timeframe
        self.row_size = row_size if row_size is not None else default_row_size(symbol)
        self.tf_minutes = TIMEFRAME_MINUTES[timeframe]
        self.engine = OrderFlowEngine(symbol, timeframe, self.cfg)
        self.current: Optional[FootprintCandle] = None
        # daily session VWAP accumulators (reset on exchange-day change)
        self.session_date: Optional[str] = None
        self.session_price_volume_sum = 0.0
        self.session_volume_sum = 0.0
        self.session_price_squared_volume_sum = 0.0   # raw 2nd moment (retained)
        # West (1979) incremental weighted variance — numerically stable VWAP std.
        self._vwap_mean = 0.0
        self._vwap_m2 = 0.0
        self._vwap_minute = -1            # cache the day string per minute bucket

    # ---- bucket helpers ----
    def _bucket_bounds(self, ts_ms: int) -> tuple[int, int]:
        tf_ms = self.tf_minutes * 60_000
        start = (ts_ms // tf_ms) * tf_ms
        return start, start + tf_ms

    def _needs_new_candle(self, tick: Tick) -> bool:
        if self.current is None:
            return True
        if self.tf_minutes == 0:  # tick bars: roll on count
            return self.current.tick_count >= TICK_BAR_SIZE
        return tick.timestamp >= self.current.end_time

    def _new_candle(self, tick: Tick) -> FootprintCandle:
        if self.tf_minutes == 0:
            start, end = tick.timestamp, tick.timestamp  # end advances with ticks
        else:
            start, end = self._bucket_bounds(tick.timestamp)
        return FootprintCandle(
            symbol=self.symbol,
            timeframe=self.timeframe,
            start_time=start,
            end_time=end,
            row_size=self.row_size,
        )

    def _update_session_vwap(self, tick: Tick) -> tuple[Optional[float], Optional[float]]:
        """Accumulate the running daily VWAP + std-dev, resetting on the exchange day.

        The reset anchors to the EXCHANGE trading session (config offset + session
        open), not the host clock or UTC: the epoch is shifted to exchange-local time
        and the session-day rolls at the configured open (e.g. 09:15 IST for NSE), so
        ticks before the open belong to the previous session day. The date can only
        change at a minute boundary, so the strftime is computed at most once/minute.

        Non-positive-volume ticks (bad/synthetic data) carry no VWAP information and
        are *not* accumulated, so they can never corrupt the running sums or clobber
        a previously valid VWAP. The date reset still applies to them.

        Returns (vwap, std_dev); both None until the session sees positive volume.
        """
        minute = tick.timestamp // 60_000
        if minute != self._vwap_minute:
            self._vwap_minute = minute
            local_ts_sec = (tick.timestamp / 1000.0) + (self.cfg.exchange_timezone_offset_minutes * 60)
            struct_time = time.gmtime(local_ts_sec)

            session_start_min = 0
            if self.cfg.exchange_session_start:
                try:
                    h, m = map(int, self.cfg.exchange_session_start.split(":"))
                    session_start_min = h * 60 + m
                except ValueError:
                    pass

            minute_of_day = struct_time.tm_hour * 60 + struct_time.tm_min
            if minute_of_day < session_start_min:
                # before the exchange open -> this tick belongs to the prior session day
                struct_time = time.gmtime(local_ts_sec - 86400)

            day = time.strftime("%Y%m%d", struct_time)
            if day != self.session_date:
                self.session_date = day
                self.session_price_volume_sum = 0.0
                self.session_volume_sum = 0.0
                self.session_price_squared_volume_sum = 0.0
                self._vwap_mean = 0.0
                self._vwap_m2 = 0.0
        if tick.volume > 0:
            self.session_price_volume_sum += tick.price * tick.volume
            self.session_volume_sum += tick.volume
            self.session_price_squared_volume_sum += (tick.price ** 2) * tick.volume
            # West incremental weighted variance: stable even at index price scale.
            # (The naive sum-of-squares form E[x^2]-E[x]^2 suffers catastrophic
            # cancellation for tight intraday ranges around large prices — e.g. a
            # 0.5-pt BANKNIFTY consolidation @51500 — producing badly wrong bands.)
            mean_prev = self._vwap_mean
            self._vwap_mean = mean_prev + (tick.volume / self.session_volume_sum) * (tick.price - mean_prev)
            self._vwap_m2 += tick.volume * (tick.price - mean_prev) * (tick.price - self._vwap_mean)
        if self.session_volume_sum <= 0:
            return None, None
        vwap = self.session_price_volume_sum / self.session_volume_sum
        # volume-weighted population variance from the (non-negative) West M2.
        variance = self._vwap_m2 / self.session_volume_sum if self.session_volume_sum > 0 else 0.0
        std_dev = (variance if variance > 0.0 else 0.0) ** 0.5
        return vwap, std_dev

    # ---- main entry ----
    def add_tick(self, tick: Tick) -> CandleEvent:
        # update session VWAP first; the closing candle keeps the vwap it already
        # carried from its own last tick, the new tick flows into the next candle.
        vwap, std_dev = self._update_session_vwap(tick)

        closed: Optional[FootprintCandle] = None
        if self._needs_new_candle(tick):
            if self.current is not None:
                closed = self.engine.analyze(self.current, commit=True)
            self.current = self._new_candle(tick)

        fold_tick(self.current, tick)
        if self.tf_minutes == 0:
            self.current.end_time = tick.timestamp
        # never overwrite a real VWAP with None (e.g. a stray zero-volume tick);
        # a candle's vwap stays None only until the session sees its first volume.
        if vwap is not None:
            self.current.vwap = vwap
            self.current.vwap_sd1_upper = vwap + std_dev
            self.current.vwap_sd1_lower = vwap - std_dev
            self.current.vwap_sd2_upper = vwap + 2 * std_dev
            self.current.vwap_sd2_lower = vwap - 2 * std_dev
        live = self.engine.analyze(self.current, commit=False)
        return CandleEvent(self.timeframe, live, closed)


def consolidate_candle(candle: FootprintCandle, row_size: float,
                       cfg: Optional[Settings] = None) -> FootprintCandle:
    """Re-bin a candle's price rows into coarser `row_size` buckets (price grouping).

    Cell bid/ask volumes are summed per bin; candle-level metrics (OHLC, delta,
    VWAP, candle signals) are scale-invariant and preserved, while imbalances,
    stacked zones, volume nodes and the POC are re-evaluated at the new scale.

    NOTE: this groups already-binned cells, so for instruments whose base row size
    is > 1 (e.g. NIFTY=5) the consolidated bin price can differ by up to base/2 from
    a *native* fold of raw ticks at `row_size` (double rounding). Totals/delta/POC
    are unaffected; only a boundary cell's price label may shift. base==1 symbols
    (stocks/MCX/crypto) are exact. Historical snapshots use this path; the live
    consolidated candle is a native fold — see pipeline.snapshot.
    """
    cfg = cfg or default_settings
    # grouping only coarsens; a finer/equal target can't recover lost detail, so
    # return the source unchanged rather than fabricating a fake-fine footprint.
    if row_size <= candle.row_size:
        return candle
    out = FootprintCandle(
        symbol=candle.symbol, timeframe=candle.timeframe,
        start_time=candle.start_time, end_time=candle.end_time, row_size=row_size,
    )
    out.open, out.high, out.low, out.close = candle.open, candle.high, candle.low, candle.close
    out.cum_delta = candle.cum_delta
    out.vwap = candle.vwap
    out.vwap_sd1_upper, out.vwap_sd1_lower = candle.vwap_sd1_upper, candle.vwap_sd1_lower
    out.vwap_sd2_upper, out.vwap_sd2_lower = candle.vwap_sd2_upper, candle.vwap_sd2_lower
    out.max_delta, out.min_delta = candle.max_delta, candle.min_delta
    out.market_structure = candle.market_structure
    out.closed = candle.closed
    out.tick_count = candle.tick_count
    # candle-level signals (absorption/LP/AD/...) don't change with row grouping
    out.signals = copy.deepcopy(candle.signals)

    for cell in candle.cells.values():
        binp = price_to_row(cell.price, row_size)
        b = out.cells.get(binp)
        if b is None:
            b = FootprintCell(price=binp)
            out.cells[binp] = b
        b.bid_volume += cell.bid_volume
        b.ask_volume += cell.ask_volume

    # re-evaluate cell-scale derived data at the consolidated granularity
    imbalance.flag_imbalances(out, cfg.imbalance_ratio, cfg.imbalance_min_volume)
    out.signals.stacked_imbalances = imbalance.find_stacked(out, cfg.stacked_imbalance_count)
    _recompute_volume_nodes(out)
    return out


def _recompute_volume_nodes(candle: FootprintCandle) -> None:
    """High/low volume nodes (total > mean+2σ / < mean-2σ) at the candle's scale."""
    totals = [c.total for c in candle.cells.values()]
    candle.signals.hvn = []
    candle.signals.lvn = []
    if len(totals) < 3:
        return
    mean = sum(totals) / len(totals)
    std = (sum((t - mean) ** 2 for t in totals) / len(totals)) ** 0.5
    if std <= 0:
        return
    hi, lo = mean + 2 * std, mean - 2 * std
    for c in candle.cells.values():
        if c.total > hi:
            candle.signals.hvn.append(c.price)
        elif c.total < lo:
            candle.signals.lvn.append(c.price)


class AggregatorManager:
    """Routes ticks to one BASE aggregator per (symbol, timeframe) and tracks the
    active consolidation (coarser row size) levels requested for each.

    Consolidated views are *grouped* from the base candle via consolidate_candle
    (see Pipeline), NOT folded natively at the coarse size — so a live consolidated
    candle and a historical consolidated snapshot use identical binning (no seam).
    """

    def __init__(self, timeframes: Optional[list[str]] = None, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self.timeframes = timeframes or [self.cfg.default_timeframe]
        self._aggs: dict[tuple[str, str, float], Aggregator] = {}
        # (symbol, timeframe) -> set of coarse row sizes to group the base into
        self._consolidations: dict[tuple[str, str], set[float]] = {}

    def _agg(self, symbol: str, timeframe: str, row_size: float) -> Aggregator:
        key = (symbol, timeframe, row_size)
        agg = self._aggs.get(key)
        if agg is None:
            agg = Aggregator(symbol, timeframe, row_size=row_size, cfg=self.cfg)
            self._aggs[key] = agg
        return agg

    def ensure(self, symbol: str, timeframe: str, row_size: Optional[float] = None) -> Aggregator:
        """Ensure the BASE aggregator exists; register a coarser row size (if any)
        as an active consolidation to be grouped from the base candle."""
        base = default_row_size(symbol)
        agg = self._agg(symbol, timeframe, base)
        rs = row_size if row_size is not None else base
        if rs != base:
            self._consolidations.setdefault((symbol, timeframe), set()).add(rs)
        return agg

    def consolidations_for(self, symbol: str, timeframe: str) -> list[float]:
        return list(self._consolidations.get((symbol, timeframe), ()))

    def add_timeframe(self, timeframe: str) -> None:
        if timeframe not in self.timeframes:
            self.timeframes.append(timeframe)

    def process(self, tick: Tick) -> list[CandleEvent]:
        # Process tick for all active (base) aggregators that match the tick's symbol.
        return [
            agg.add_tick(tick)
            for (sym, tf, rs), agg in list(self._aggs.items())
            if sym == tick.symbol
        ]

    def snapshot(self, symbol: str, timeframe: str, row_size: Optional[float] = None) -> Optional[FootprintCandle]:
        rs = row_size if row_size is not None else default_row_size(symbol)
        agg = self._aggs.get((symbol, timeframe, rs))
        return agg.current if agg else None
