"""On-demand sub-minute (e.g. 5-second) footprint reconstruction from stored ticks.

This is DELIBERATELY separate from the live `Aggregator`/pipeline: seconds bars are
NOT generated or persisted continuously (they would explode candle/row counts). Instead
`/api/footprints?timeframe=5S` reconstructs them on request from the indexed `ticks`
table, bounded by a tight limit, purely to feed indicator lower-timeframe orderflow
(SC1 V4's 5S child bars: buy/sell/delta volume, from which the frontend builds the
per-parent CVD path / maxDelta / minDelta exactly like Pine's requestVolumeDelta).

Each bucket is built with the SAME `fold_tick` classification the live candles use
(BUY->ask, SELL->bid, NEUTRAL->split), so the orderflow numbers are identical to what a
native fold would produce — just at a 5s grid. No OrderFlowEngine runs (no per-tick
analyze), so reconstructing tens of thousands of buckets stays cheap.
"""
from __future__ import annotations

from typing import Iterable

from ..orderflow.footprint import add_tick as fold_tick
from ..orderflow.models import FootprintCandle, Tick, TradeSide


def _coerce_side(value: object) -> TradeSide:
    if isinstance(value, TradeSide):
        return value
    try:
        return TradeSide(str(value))
    except Exception:
        return TradeSide.NEUTRAL


def aggregate_ticks_to_candles(
    ticks: Iterable[dict],
    symbol: str,
    timeframe: str,
    bucket_ms: int,
    row_size: float,
) -> list[FootprintCandle]:
    """Bucket pre-sorted (ascending `ts`) tick rows into fixed `bucket_ms` footprint
    candles. Only buckets that actually contain ticks produce a candle (quiet gaps are
    skipped — callers gate on coverage). Returns candles oldest-first.

    `ticks` rows are dicts with keys: ts (epoch ms), price, volume, bid, ask, side.
    """
    if bucket_ms <= 0:
        return []
    out: list[FootprintCandle] = []
    cur: FootprintCandle | None = None
    cur_start = -1
    for r in ticks:
        ts = int(r["ts"])
        start = (ts // bucket_ms) * bucket_ms
        if cur is None or start != cur_start:
            if cur is not None:
                out.append(cur)
            cur = FootprintCandle(
                symbol=symbol, timeframe=timeframe,
                start_time=start, end_time=start + bucket_ms, row_size=row_size,
            )
            cur_start = start
        tick = Tick(
            symbol=symbol,
            timestamp=ts,
            price=float(r["price"]),
            volume=float(r["volume"]),
            bid=(None if r.get("bid") is None else float(r["bid"])),
            ask=(None if r.get("ask") is None else float(r["ask"])),
            side=_coerce_side(r.get("side")),
        )
        fold_tick(cur, tick)
    if cur is not None:
        out.append(cur)
    return out
