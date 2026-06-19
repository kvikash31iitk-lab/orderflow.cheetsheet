"""Targeted reaggregation for the DataBento futures (6E.V.0 / GC.V.0) ONLY.

Unlike reaggregate.py (which TRUNCATEs every derived table and rebuilds all symbols),
this deletes just the 6E.V.0/GC.V.0 rows and rebuilds their footprints from the ticks
table. TrueData symbols (NIFTY-I etc.) are left completely untouched, so the existing
NSE footprint history can't be damaged and the live terminal isn't disrupted.
"""
import asyncio
import logging

from app.config import settings
from app.storage.postgres import PostgresRepo
from app.market_data.aggregator import Aggregator
from app.orderflow.models import Tick, TradeSide

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reaggregate_databento")

SYMBOLS = ["6E.V.0", "GC.V.0"]
# derived tables save_candle() may write to; deleted per-symbol (try/except so a
# table without a `symbol` column is simply skipped).
DERIVED_TABLES = [
    "footprints", "absorption", "exhaustion", "lp_signals",
    "ad_signals", "imbalances", "delta", "cum_delta",
]
TIMEFRAMES = ["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"]


async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to database")
        return

    log.info("Deleting existing derived rows for %s ...", SYMBOLS)
    async with repo.pool.acquire() as con:
        for t in DERIVED_TABLES:
            try:
                res = await con.execute(f"DELETE FROM {t} WHERE symbol = ANY($1::text[])", SYMBOLS)
                log.info("  %-12s %s", t, res)
            except Exception as e:  # noqa: BLE001 - table may lack a symbol column
                log.warning("  skip %-12s (%s)", t, e)

    log.info("Loading ticks for %s ...", SYMBOLS)
    async with repo.pool.acquire() as con:
        rows = await con.fetch(
            "SELECT symbol, ts, price, volume, bid, ask, side FROM ticks "
            "WHERE symbol = ANY($1::text[]) ORDER BY ts",
            SYMBOLS,
        )
    log.info("Loaded %d ticks.", len(rows))

    by_symbol = {}
    for r in rows:
        by_symbol.setdefault(r["symbol"], []).append(r)

    total = 0
    for sym, srows in by_symbol.items():
        ticks = [
            Tick(symbol=r["symbol"], timestamp=r["ts"], price=r["price"], volume=r["volume"],
                 bid=r["bid"], ask=r["ask"], side=TradeSide(r["side"]))
            for r in srows
        ]
        log.info("%s: %d ticks", sym, len(ticks))
        for tf in TIMEFRAMES:
            agg = Aggregator(sym, tf, cfg=settings)
            n = 0
            for tick in ticks:
                ev = agg.add_tick(tick)
                if ev.closed is not None:
                    await repo.save_candle(ev.closed)
                    n += 1
            if agg.current is not None:
                live = agg.engine.analyze(agg.current, commit=False)
                await repo.save_candle(live)
                n += 1
            total += n
            log.info("  %s %-4s -> %d candles", sym, tf, n)

    await repo.close()
    log.info("Targeted reaggregation complete. Total candles saved: %d", total)


if __name__ == "__main__":
    asyncio.run(main())
