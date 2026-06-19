"""Targeted reaggregation for 6E.V.0 ONLY (GC.V.0 already rebuilt). Same logic as
reaggregate_databento.py but scoped to a single symbol so it can be re-run safely
without redoing GC. TrueData symbols are never touched."""
import asyncio
import logging
import traceback

from app.config import settings
from app.storage.postgres import PostgresRepo
from app.market_data.aggregator import Aggregator
from app.orderflow.models import Tick, TradeSide

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reaggregate_6e")

SYMBOLS = ["6E.V.0"]
DERIVED_TABLES = [
    "footprints", "absorption", "exhaustion", "lp_signals",
    "ad_signals", "imbalances", "delta", "cum_delta",
]
# Higher timeframes FIRST: they build in seconds and give the full June 1-18 view
# immediately; the slow high-cardinality low TFs (recent-detail only) build last.
TIMEFRAMES = ["1D", "4h", "1h", "30m", "15m", "5m", "3m", "2m", "1m"]


async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("no DB")
        return

    log.info("Deleting existing derived rows for %s ...", SYMBOLS)
    async with repo.pool.acquire() as con:
        for t in DERIVED_TABLES:
            try:
                res = await con.execute(f"DELETE FROM {t} WHERE symbol = ANY($1::text[])", SYMBOLS)
                log.info("  %-12s %s", t, res)
            except Exception as e:  # noqa: BLE001
                log.warning("  skip %-12s (%s)", t, e)

    async with repo.pool.acquire() as con:
        rows = await con.fetch(
            "SELECT symbol, ts, price, volume, bid, ask, side FROM ticks "
            "WHERE symbol = ANY($1::text[]) ORDER BY ts",
            SYMBOLS,
        )
    log.info("Loaded %d ticks for %s.", len(rows), SYMBOLS)

    ticks = [
        Tick(symbol=r["symbol"], timestamp=r["ts"], price=r["price"], volume=r["volume"],
             bid=r["bid"], ask=r["ask"], side=TradeSide(r["side"]))
        for r in rows
    ]
    total = 0
    for tf in TIMEFRAMES:
        try:
            agg = Aggregator("6E.V.0", tf, cfg=settings)
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
            log.info("  6E.V.0 %-4s -> %d candles", tf, n)
        except Exception:
            log.error("6E.V.0 %s FAILED:\n%s", tf, traceback.format_exc())

    await repo.close()
    log.info("6E reaggregation complete. Total candles saved: %d", total)


if __name__ == "__main__":
    asyncio.run(main())
