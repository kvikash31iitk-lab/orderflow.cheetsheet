"""Volume imbalance + stacked-imbalance detection.

Diagonal imbalance (the standard footprint definition): aggressive buyers at a
price row are compared against aggressive sellers *one row below*, and aggressive
sellers at a row against aggressive buyers *one row above*. Rows are scanned in
ascending price order.

    buy  (bullish) @ P_i : ask_volume[P_i] / bid_volume[P_{i-1}] >= ratio
    sell (bearish) @ P_i : bid_volume[P_i] / ask_volume[P_{i+1}] >= ratio

A minimum volume on the cell's own dominant side filters microstructure noise.
Boundary rows are never flagged against a missing neighbour: the bottom row gets
no buy imbalance and the top row gets no sell imbalance.

Stacked imbalance = >= N consecutive price rows imbalanced in the SAME direction.
"""
from __future__ import annotations

from .models import FootprintCandle, ImbalanceZone


def flag_imbalances(candle: FootprintCandle, ratio: float, min_volume: float) -> None:
    """Set buy_imbalance / sell_imbalance on each cell in place (diagonal).

    Neighbours are looked up by *exact price* (`price ± row_size`) rather than by
    list position, so a price gap (a row with no trades) is handled correctly:
    the missing neighbour's volume is treated as 0.0, which means an isolated row
    facing an empty diagonal neighbour is a (maximal) imbalance.
    """
    cells = candle.cells
    if not cells:
        return
    row_size = candle.row_size
    tol = row_size * 0.5  # rows are multiples of row_size; tolerate float drift

    # Walk prices in ascending order. The diagonal neighbour at price ∓ row_size
    # is the adjacent sorted entry *only* when no gap separates them; otherwise it
    # is missing and its volume is treated as 0.0. This avoids per-cell round()/get.
    prices = sorted(cells)
    for cell in cells.values():
        cell.buy_imbalance = False
        cell.sell_imbalance = False

    n = len(prices)
    for i, price in enumerate(prices):
        cell = cells[price]

        # bullish: this row's ask vs the bid of the row below it (price - row_size).
        if i > 0 and cell.ask_volume >= min_volume:
            prev = prices[i - 1]
            below_bid = cells[prev].bid_volume if abs(price - prev - row_size) <= tol else 0.0
            if below_bid <= 0 or cell.ask_volume / below_bid >= ratio:
                cell.buy_imbalance = True          # empty diagonal -> max imbalance

        # bearish: this row's bid vs the ask of the row above it (price + row_size).
        if i < n - 1 and cell.bid_volume >= min_volume:
            nxt = prices[i + 1]
            above_ask = cells[nxt].ask_volume if abs(nxt - price - row_size) <= tol else 0.0
            if above_ask <= 0 or cell.bid_volume / above_ask >= ratio:
                cell.sell_imbalance = True


def find_stacked(candle: FootprintCandle, min_count: int) -> list[ImbalanceZone]:
    """Find runs of >= min_count consecutive same-direction imbalanced rows.

    Rows are scanned from low price to high price; a 'run' is consecutive entries
    in the sorted list of populated cells.
    """
    zones: list[ImbalanceZone] = []
    rows = sorted(candle.cells.keys())  # ascending price
    if len(rows) < min_count:
        return zones

    run_dir: str | None = None
    run_prices: list[float] = []

    def flush() -> None:
        if run_dir and len(run_prices) >= min_count:
            zones.append(
                ImbalanceZone(
                    direction=run_dir,
                    start_price=min(run_prices),
                    end_price=max(run_prices),
                    count=len(run_prices),
                )
            )

    for row in rows:
        cell = candle.cells[row]
        if cell.buy_imbalance:
            d = "bullish"
        elif cell.sell_imbalance:
            d = "bearish"
        else:
            d = None

        if d is None:
            flush()
            run_dir, run_prices = None, []
        elif d == run_dir:
            run_prices.append(row)
        else:
            flush()
            run_dir, run_prices = d, [row]
    flush()
    return zones
