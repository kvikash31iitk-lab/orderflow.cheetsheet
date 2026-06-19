import asyncio
import logging
from pathlib import Path
import pyarrow.parquet as pq
from app.config import settings
from app.storage.postgres import PostgresRepo

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("import_parquet")

async def main():
    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to PostgreSQL database")
        return

    # 1) Truncate ticks table to start clean
    log.info("Truncating ticks table to prevent duplicates...")
    async with repo.pool.acquire() as con:
        await con.execute("TRUNCATE TABLE ticks RESTART IDENTITY")

    # 2) Find all parquet files in /data/ticks/
    ticks_dir = Path("/data/ticks")
    files = sorted(ticks_dir.glob("ticks_*.parquet"))
    if not files:
        # Fallback to local path for workspace testing
        ticks_dir = Path("data/ticks")
        files = sorted(ticks_dir.glob("ticks_*.parquet"))

    log.info(f"Found {len(files)} parquet files to import: {[f.name for f in files]}")

    for file_path in files:
        log.info(f"Reading {file_path.name}...")
        try:
            table = pq.read_table(file_path)
            rows = table.to_pylist()
            log.info(f"Loaded {len(rows)} ticks from parquet file.")

            # Map fields and prepare for executemany
            records = []
            for r in rows:
                ts = r.get("timestamp") or r.get("ts")
                records.append((
                    r["symbol"],
                    ts,
                    r["price"],
                    r["volume"],
                    r.get("bid"),
                    r.get("ask"),
                    r.get("side", "NEUTRAL")
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
            log.info(f"Successfully imported {file_path.name}")
        except Exception as exc:
            log.error(f"Failed to import {file_path.name}: {exc}")

    await repo.close()
    log.info("Parquet ticks import complete!")

if __name__ == "__main__":
    asyncio.run(main())
