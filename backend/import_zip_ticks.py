import asyncio
import csv
import io
import logging
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from app.config import settings
from app.storage.postgres import PostgresRepo

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("import_zip_ticks")

async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to PostgreSQL database")
        return

    zip_path = Path("/app/truedata_orderflow_export.zip")
    if not zip_path.exists():
        # Fallback for workspace testing
        zip_path = Path("truedata_orderflow_export.zip")
        if not zip_path.exists():
            log.error(f"Zip file not found at {zip_path}")
            return

    # NSE trades operate in IST (UTC+5:30)
    tz_ist = timezone(timedelta(hours=5, minutes=30))

    log.info(f"Opening zip file {zip_path}...")
    with zipfile.ZipFile(zip_path, 'r') as zf:
        # Dynamically discover all CSV files in normalized_ticks, handling any slash separator style
        tick_files = [x for x in zf.namelist() if "normalized_ticks" in x and x.endswith(".csv")]
        log.info(f"Found {len(tick_files)} tick files to process.")
        
        for file_name in tick_files:
            display_name = file_name.split('/')[-1].split('\\')[-1]
            log.info(f"Processing {display_name}...")
            try:
                with zf.open(file_name) as f:
                    content = io.TextIOWrapper(f, encoding='utf-8')
                    reader = csv.reader(content)
                    headers = next(reader)
                    
                    # Identify indexes
                    ts_idx = headers.index('timestamp')
                    sym_idx = headers.index('symbol')
                    price_idx = headers.index('trade_price')
                    vol_idx = headers.index('trade_size_derived')
                    bid_idx = headers.index('bid')
                    ask_idx = headers.index('ask')
                    side_idx = headers.index('inferred_side')
                    
                    records = []
                    for row in reader:
                        if not row:
                            continue
                        
                        # Convert ISO timestamp to epoch milliseconds
                        ts_str = row[ts_idx]
                        dt = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=tz_ist)
                        ts_ms = int(dt.timestamp() * 1000)
                        
                        # Normalize side uppercase format
                        side = row[side_idx].upper()
                        if side not in ("BUY", "SELL"):
                            side = "NEUTRAL"
                            
                        # Handle optional fields safely
                        bid_val = float(row[bid_idx]) if row[bid_idx] else None
                        ask_val = float(row[ask_idx]) if row[ask_idx] else None
                        
                        records.append((
                            row[sym_idx],
                            ts_ms,
                            float(row[price_idx]),
                            float(row[vol_idx]),
                            bid_val,
                            ask_val,
                            side
                        ))

                # Batch insert
                batch_size = 5000
                async with repo.pool.acquire() as con:
                    for i in range(0, len(records), batch_size):
                        batch = records[i:i+batch_size]
                        await con.executemany(
                            "INSERT INTO ticks (symbol, ts, price, volume, bid, ask, side) "
                            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
                            batch
                        )
                log.info(f"Successfully imported {len(records)} ticks from {display_name}")
            except Exception as exc:
                log.error(f"Failed to process {display_name}: {exc}")

    await repo.close()
    log.info("Historical ticks import complete!")

if __name__ == "__main__":
    asyncio.run(main())
