"""Footprint construction: fold a classified tick into a candle's price rows."""
from __future__ import annotations

import math

from .models import FootprintCandle, FootprintCell, Tick, TradeSide


def price_to_row(price: float, row_size: float) -> float:
    """Bucket a raw price into a footprint row (the candle's vertical granularity)."""
    if row_size <= 0:
        return round(price, 4)
    # Snap to the grid, then strip float-multiplication noise. Round to enough
    # decimals to preserve sub-0.001 ticks (e.g. 6E Euro-FX at 0.00005, which needs
    # 5 dp) while keeping the historical 4-dp behaviour for every coarser instrument:
    # for any row_size >= 0.001 this is exactly round(..., 4), so existing symbols
    # (NIFTY 0.1, ES 0.25, GC 0.10, AAPL 0.01, ...) are bit-for-bit unchanged.
    ndigits = max(4, 1 - math.floor(math.log10(row_size)))
    return round(round(price / row_size) * row_size, ndigits)


def _cell(candle: FootprintCandle, row: float) -> FootprintCell:
    cell = candle.cells.get(row)
    if cell is None:
        cell = FootprintCell(price=row)
        candle.cells[row] = cell
    return cell


def add_tick(candle: FootprintCandle, tick: Tick) -> None:
    """Accumulate one classified tick into the candle (OHLC + bid/ask cell volume).

    BUY  -> ask_volume (aggressive buyer, green).
    SELL -> bid_volume (aggressive seller, red).
    NEUTRAL -> split 50/50 so total volume is preserved without biasing delta.
    """
    price = tick.price
    vol = tick.volume

    # OHLC
    if candle.tick_count == 0:
        candle.open = candle.high = candle.low = candle.close = price
    else:
        candle.high = max(candle.high, price)
        candle.low = min(candle.low, price)
        candle.close = price
    candle.tick_count += 1

    row = price_to_row(price, candle.row_size)
    cell = _cell(candle, row)

    if tick.side is TradeSide.BUY:
        cell.ask_volume += vol
    elif tick.side is TradeSide.SELL:
        cell.bid_volume += vol
    else:  # NEUTRAL
        cell.ask_volume += vol / 2.0
        cell.bid_volume += vol / 2.0

    # track the peak / trough the running candle delta reaches intra-bar
    delta = candle.delta
    candle.max_delta = max(candle.max_delta, delta)
    candle.min_delta = min(candle.min_delta, delta)
