import asyncio
import logging
import time
from datetime import datetime, timezone, timedelta
from app.config import settings
from app.storage.postgres import PostgresRepo
from app.market_data.tick_handler import TickHandler

# Databento encodes "no price" as INT64_MAX; guard against scaling it
UNDEF_PRICE = 9223372036854775807

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("backfill_databento")

async def main():
    try:
        import databento as db
    except ImportError as e:
        log.error("Failed to import databento package: %s", e)
        return

    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to PostgreSQL database")
        return

    # Initialize Databento historical client (key must come from .env / environment)
    api_key = settings.databento_api_key
    if not api_key:
        log.error("DATABENTO_API_KEY not set; export it or add it to .env")
        return
    log.info("Initializing Databento Historical client...")
    client = db.Historical(api_key)

    symbols = ["6E.v.0", "GC.v.0"]
    
    # We backfill from June 1st, 2026 up to today (June 18th, 2026)
    start_date = datetime(2026, 6, 1)
    end_date = datetime(2026, 6, 18)
    
    handler = TickHandler()
    total_inserted = 0

    current_day = start_date
    while current_day <= end_date:
        day_str = current_day.strftime("%Y-%m-%d")
        
        # Databento expects UTC start/end times
        start_dt = datetime(current_day.year, current_day.month, current_day.day, 0, 0, 0, tzinfo=timezone.utc)
        end_dt = datetime(current_day.year, current_day.month, current_day.day, 23, 59, 59, tzinfo=timezone.utc)
        
        ts_start_ms = int(start_dt.timestamp() * 1000)
        ts_end_ms = int(end_dt.timestamp() * 1000)

        for symbol in symbols:
            # We save continuous contracts as uppercase canonical names (e.g. 6E.V.0)
            db_symbol = symbol.upper()
            log.info(f"[{db_symbol}] Fetching history for {day_str}...")

            try:
                # Get running event loop to execute blocking historical fetch in executor
                loop = asyncio.get_running_loop()
                def _fetch():
                    return client.timeseries.get_range(
                        dataset="GLBX.MDP3",
                        start=start_dt.isoformat(),
                        end=end_dt.isoformat(),
                        symbols=symbol,
                        stype_in="continuous",
                        schema="tbbo",
                    )
                
                data = await loop.run_in_executor(None, _fetch)
                records = list(data)
                
                if not records:
                    log.warning(f"[{db_symbol}] No records returned for {day_str}")
                    continue

                log.info(f"[{db_symbol}] Fetched {len(records)} raw records. Processing...")
                
                # Map to standard tick dict format and sort chronologically
                mapped = []
                for rec in records:
                    if type(rec).__name__ == "SymbolMappingMsg":
                        continue

                    ts_event = getattr(rec, "ts_event", None)
                    price = getattr(rec, "price", None)
                    size = getattr(rec, "size", None)
                    if ts_event is None or price is None or size is None or price == UNDEF_PRICE:
                        continue

                    price_val = float(price) * 1e-9
                    vol_val = float(size)
                    ts_ms = int(ts_event // 1_000_000)

                    bid_val = None
                    ask_val = None
                    levels = getattr(rec, "levels", None)
                    if levels and len(levels) > 0:
                        bid_px = getattr(levels[0], "bid_px", None)
                        ask_px = getattr(levels[0], "ask_px", None)
                        if bid_px is not None and bid_px != UNDEF_PRICE:
                            bid_val = float(bid_px) * 1e-9
                        if ask_px is not None and ask_px != UNDEF_PRICE:
                            ask_val = float(ask_px) * 1e-9

                    mapped.append({
                        "symbol": db_symbol,
                        "timestamp": ts_ms,
                        "price": price_val,
                        "volume": vol_val,
                        "bid": bid_val,
                        "ask": ask_val,
                    })

                # Sort chronologically to apply the stateful tick rule correctly
                mapped.sort(key=lambda x: x["timestamp"])

                # Apply tick rule and prepare DB records
                db_records = []
                for m in mapped:
                    tick = handler.normalise(
                        symbol=m["symbol"],
                        timestamp=m["timestamp"],
                        price=m["price"],
                        volume=m["volume"],
                        bid=m["bid"],
                        ask=m["ask"]
                    )
                    db_records.append((
                        tick.symbol,
                        tick.timestamp,
                        tick.price,
                        tick.volume,
                        tick.bid,
                        tick.ask,
                        tick.side.value
                    ))

                # Delete existing records for this day/symbol
                async with repo.pool.acquire() as con:
                    deleted = await con.execute(
                        "DELETE FROM ticks WHERE symbol = $1 AND ts >= $2 AND ts <= $3",
                        db_symbol, ts_start_ms, ts_end_ms
                    )
                    log.info(f"[{db_symbol}] Deleted existing ticks: {deleted}")
                    
                    # Batch insert
                    batch_size = 5000
                    for i in range(0, len(db_records), batch_size):
                        batch = db_records[i : i + batch_size]
                        await con.executemany(
                            "INSERT INTO ticks (symbol, ts, price, volume, bid, ask, side) "
                            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
                            batch
                        )
                
                log.info(f"[{db_symbol}] Successfully imported {len(db_records)} ticks for {day_str}")
                total_inserted += len(db_records)

            except Exception as exc:
                log.error(f"[{db_symbol}] Failed for {day_str}: {exc}", exc_info=True)

            # Sleep briefly to avoid aggressive rate limits
            await asyncio.sleep(1.0)

        # Move to next day
        current_day += timedelta(days=1)

    await repo.close()
    log.info(f"Databento historical ticks backfill complete! Total inserted: {total_inserted}")

if __name__ == "__main__":
    asyncio.run(main())
