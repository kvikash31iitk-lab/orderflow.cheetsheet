import asyncio
import logging
import time
from datetime import datetime, timezone, timedelta
from app.config import settings
from app.storage.postgres import PostgresRepo
from app.market_data.websocket_client import _history_record_to_raw
from app.market_data.tick_handler import TickHandler
from truedata_ws.websocket.TD import TD

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("backfill_history")

async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to PostgreSQL database")
        return

    log.info("Connecting to TrueData...")
    td = TD(
        settings.truedata_username,
        settings.truedata_password,
        live_port=settings.truedata_live_port,
        url=settings.truedata_url,
        log_level=logging.WARNING,
    )
    
    # Wait for session connection
    log.info("Waiting for session connection...")
    time.sleep(5)

    symbols = ["NIFTY-I", "BANKNIFTY-I", "FINNIFTY-I", "MIDCPNIFTY-I"]
    target_days = [11, 12, 15, 16]
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    
    # Stateful classifier for trade sides
    handler = TickHandler()
    
    total_inserted = 0

    for symbol in symbols:
        for day in target_days:
            start_dt = datetime(2026, 6, day, 9, 15, 0)
            end_dt = datetime(2026, 6, day, 15, 30, 0)
            
            # UTC millisecond range for deletion of the entire calendar day (IST)
            day_start_ist = datetime(2026, 6, day, 0, 0, 0, tzinfo=tz_ist)
            day_end_ist = datetime(2026, 6, day, 23, 59, 59, tzinfo=tz_ist)
            ts_start = int(day_start_ist.timestamp() * 1000)
            ts_end = int(day_end_ist.timestamp() * 1000)
            
            log.info(f"[{symbol}] Fetching history for 2026-06-{day:02d}...")
            
            try:
                raw_data = td.get_historic_data(
                    symbol,
                    start_time=start_dt,
                    end_time=end_dt,
                    bar_size="tick",
                    bidask=True
                )
                
                if not raw_data:
                    log.warning(f"[{symbol}] No records returned for 2026-06-{day:02d}")
                    time.sleep(2)
                    continue
                
                log.info(f"[{symbol}] Fetched {len(raw_data)} raw records. Processing...")
                
                # Map to standard format
                mapped = []
                for rec in raw_data:
                    m = _history_record_to_raw(rec, symbol)
                    if m is not None:
                        # TrueData SDK returns naive datetimes representing IST.
                        # Since the VPS runs in UTC, _to_epoch_ms treated these naive datetimes as UTC,
                        # shifting the timestamps by +5.5 hours. Subtract 5.5 hours to correct this.
                        m["timestamp"] -= 5.5 * 60 * 60 * 1000  # 19,800,000 ms
                        mapped.append(m)
                
                # Sort chronologically to ensure the stateful tick rule is applied correctly
                mapped.sort(key=lambda x: x["timestamp"])
                
                # Classify sides and format db records
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
                        symbol, ts_start, ts_end
                    )
                    log.info(f"[{symbol}] Deleted existing ticks: {deleted}")
                    
                    # Batch insert
                    batch_size = 5000
                    for i in range(0, len(db_records), batch_size):
                        batch = db_records[i : i + batch_size]
                        await con.executemany(
                            "INSERT INTO ticks (symbol, ts, price, volume, bid, ask, side) "
                            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
                            batch
                        )
                
                log.info(f"[{symbol}] Successfully imported {len(db_records)} ticks for 2026-06-{day:02d}")
                total_inserted += len(db_records)
                
            except Exception as exc:
                log.error(f"[{symbol}] Failed for 2026-06-{day:02d}: {exc}", exc_info=True)
            
            # Rate limit protection
            time.sleep(2)
                
    log.info("Disconnecting from TrueData...")
    td.disconnect()
    await repo.close()
    log.info(f"Historical ticks backfill complete! Total inserted: {total_inserted}")

if __name__ == "__main__":
    asyncio.run(main())
