import time
import logging
from datetime import datetime, timedelta

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("test_databento_history")

def main():
    try:
        import databento as db
    except ImportError as e:
        log.error("Failed to import databento: %s", e)
        return

    # API key must be provided via the environment (never hard-code secrets).
    import os
    key = os.environ.get("DATABENTO_API_KEY", "")
    if not key:
        log.error("DATABENTO_API_KEY not set; export it or add it to .env")
        return
    log.info("Initializing Databento Historical client...")
    client = db.Historical(key)

    # Let's target yesterday's date (or a recent trading day)
    # Databento historical queries need to be within valid ranges.
    # Let's query the last 15 minutes of a trading day.
    # Note: Databento timestamps are in UTC.
    end_dt = datetime.utcnow() - timedelta(days=1)
    # Set to a fixed time range to ensure market was open (e.g. 15:00 to 15:15 UTC)
    start_dt = end_dt.replace(hour=15, minute=0, second=0, microsecond=0)
    end_dt = end_dt.replace(hour=15, minute=15, second=0, microsecond=0)

    log.info(f"Querying AAPL from DBEQ.BASIC (from {start_dt} to {end_dt})...")
    try:
        data = client.timeseries.get_range(
            dataset="DBEQ.BASIC",
            start=start_dt.isoformat(),
            end=end_dt.isoformat(),
            symbols="AAPL",
            stype_in="raw_symbol",
            schema="tbbo",
        )
        # Convert to raw list of records
        records = list(data)
        log.info(f"Fetched {len(records)} records for AAPL.")
        if records:
            rec = records[0]
            log.info("First AAPL record:")
            log.info(f"  type: {type(rec)}")
            log.info(f"  ts_event: {getattr(rec, 'ts_event', 'N/A')}")
            log.info(f"  price: {getattr(rec, 'price', 'N/A')} (scaled: {getattr(rec, 'price', 0)*1e-9})")
            log.info(f"  size: {getattr(rec, 'size', 'N/A')}")
            
            levels = getattr(rec, "levels", None)
            if levels:
                log.info(f"  levels: {levels}")
                log.info(f"  level 0: {levels[0]}")
                log.info(f"  bid_px: {getattr(levels[0], 'bid_px', 'N/A')} (scaled: {getattr(levels[0], 'bid_px', 0)*1e-9})")
                log.info(f"  ask_px: {getattr(levels[0], 'ask_px', 'N/A')} (scaled: {getattr(levels[0], 'ask_px', 0)*1e-9})")
            else:
                log.info("  No levels found on record")
            log.info(f"  side: {getattr(rec, 'side', 'N/A')}")
    except Exception as exc:
        log.exception("AAPL query failed: %s", exc)

    log.info(f"Querying ES.c.0 from GLBX.MDP3...")
    try:
        data = client.timeseries.get_range(
            dataset="GLBX.MDP3",
            start=start_dt.isoformat(),
            end=end_dt.isoformat(),
            symbols="ES.c.0",
            stype_in="continuous",
            schema="tbbo",
        )
        records = list(data)
        log.info(f"Fetched {len(records)} records for ES.c.0.")
        if records:
            rec = records[0]
            log.info("First ES.c.0 record:")
            log.info(f"  type: {type(rec)}")
            log.info(f"  ts_event: {getattr(rec, 'ts_event', 'N/A')}")
            log.info(f"  price: {getattr(rec, 'price', 'N/A')} (scaled: {getattr(rec, 'price', 0)*1e-9})")
            log.info(f"  size: {getattr(rec, 'size', 'N/A')}")
            
            levels = getattr(rec, "levels", None)
            if levels:
                log.info(f"  level 0: {levels[0]}")
                log.info(f"  bid_px: {getattr(levels[0], 'bid_px', 'N/A')} (scaled: {getattr(levels[0], 'bid_px', 0)*1e-9})")
                log.info(f"  ask_px: {getattr(levels[0], 'ask_px', 'N/A')} (scaled: {getattr(levels[0], 'ask_px', 0)*1e-9})")
            else:
                log.info("  No levels found on record")
            log.info(f"  side: {getattr(rec, 'side', 'N/A')}")
    except Exception as exc:
        log.exception("ES.c.0 query failed: %s", exc)

if __name__ == "__main__":
    main()
