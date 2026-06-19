import asyncio
import logging
from app.config import TIMEFRAME_MINUTES, settings
from app.storage.postgres import PostgresRepo
from app.market_data.aggregator import Aggregator
from app.orderflow.models import Tick, TradeSide

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reaggregate")

async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to database")
        return

    log.info("Truncating derived tables for fresh reaggregation...")
    async with repo.pool.acquire() as con:
        await con.execute(
            "TRUNCATE TABLE footprints, absorption, exhaustion, lp_signals, ad_signals, imbalances, delta, cum_delta RESTART IDENTITY"
        )

    log.info("Loading all ticks from DB...")
    async with repo.pool.acquire() as con:
        rows = await con.fetch("SELECT symbol, ts, price, volume, bid, ask, side FROM ticks ORDER BY ts")
    
    log.info(f"Loaded {len(rows)} ticks. Grouping by symbol...")
    ticks_by_symbol = {}
    for r in rows:
        sym = r["symbol"].upper()
        ticks_by_symbol.setdefault(sym, []).append(r)

    # We will aggregate for these timeframes
    timeframes = ["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"]

    for sym, symbol_rows in ticks_by_symbol.items():
        log.info(f"Processing {len(symbol_rows)} ticks for {sym}...")
        
        # Convert DB rows to Tick objects
        ticks = []
        for r in symbol_rows:
            ticks.append(Tick(
                symbol=r["symbol"],
                timestamp=r["ts"],
                price=r["price"],
                volume=r["volume"],
                bid=r["bid"],
                ask=r["ask"],
                side=TradeSide(r["side"])
            ))

        for tf in timeframes:
            log.info(f"Aggregating {sym} {tf}...")
            # aggregator will automatically use default_row_size(sym)
            agg = Aggregator(sym, tf, cfg=settings)
            
            candle_count = 0
            for tick in ticks:
                ev = agg.add_tick(tick)
                if ev.closed is not None:
                    await repo.save_candle(ev.closed)
                    candle_count += 1
            
            # Save the final open candle as well
            if agg.current is not None:
                # Analyze it to finalize signals, but don't commit to aggregator internal state
                live = agg.engine.analyze(agg.current, commit=False)
                await repo.save_candle(live)
                candle_count += 1
                
            log.info(f"Saved {candle_count} candles for {sym} {tf}")

    await repo.close()
    log.info("Reaggregation complete!")

if __name__ == "__main__":
    asyncio.run(main())
