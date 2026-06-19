"""Throughput benchmark for the order-flow ingest path.

Generates a synthetic random-walk tick stream and pushes it through the full
TickHandler -> AggregatorManager -> OrderFlowEngine pipeline (the same hot path
used live, minus IO), then reports ticks/sec and the implied ticks/minute.

    python -m scripts.benchmark            # default 200k ticks, 1 symbol, 2m tf
    python -m scripts.benchmark 500000 3
"""
from __future__ import annotations

import random
import sys
import time

from app.market_data.aggregator import AggregatorManager
from app.market_data.tick_handler import TickHandler


def make_ticks(n: int, symbols: list[str]) -> list[tuple]:
    """Pre-generate raw ticks so generation cost is excluded from the timing."""
    out: list[tuple] = []
    state = {s: (23990.0, 0.0) for s in symbols}
    t = int(time.time() * 1000)
    for i in range(n):
        sym = symbols[i % len(symbols)]
        price, drift = state[sym]
        drift = drift * 0.9 + random.uniform(-1, 1) * 0.05
        price = max(0.05, price + drift)
        spread = 0.1
        at_ask = random.random() < 0.5
        trade = price + spread / 2 if at_ask else price - spread / 2
        out.append((sym, t + i * 4, round(trade, 2), random.choice([1, 2, 5, 10, 25]),
                    round(price - spread / 2, 2), round(price + spread / 2, 2)))
        state[sym] = (price, drift)
    return out


def run(n: int, n_symbols: int, timeframe: str) -> None:
    symbols = [f"SYM{i}-I" for i in range(n_symbols)]
    ticks = make_ticks(n, symbols)
    handler = TickHandler()
    mgr = AggregatorManager(timeframes=[timeframe])
    for sym in symbols:                       # register the aggregators to fan into
        mgr.ensure(sym, timeframe)

    start = time.perf_counter()
    for (sym, ts, price, vol, bid, ask) in ticks:
        tick = handler.normalise(sym, ts, price, vol, bid, ask)
        mgr.process(tick)
    elapsed = time.perf_counter() - start

    tps = n / elapsed
    print(f"ticks            : {n:,}")
    print(f"symbols          : {n_symbols}  timeframe: {timeframe}")
    print(f"elapsed          : {elapsed:.3f} s")
    print(f"throughput       : {tps:,.0f} ticks/sec")
    print(f"implied capacity : {tps * 60:,.0f} ticks/min")
    target = 100_000
    print(f"target (100k/min): {'PASS' if tps * 60 >= target else 'FAIL'} "
          f"({tps * 60 / target:.1f}x)")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    n_symbols = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    tf = sys.argv[3] if len(sys.argv) > 3 else "2m"
    run(n, n_symbols, tf)
