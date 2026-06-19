import time
import logging
from datetime import datetime
from truedata_ws.websocket.TD import TD
from app.config import settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("test_specific_day")

def main():
    log.info("Connecting to TrueData...")
    td = TD(
        settings.truedata_username,
        settings.truedata_password,
        live_port=settings.truedata_live_port,
        url=settings.truedata_url,
        log_level=logging.INFO,
    )
    
    # Wait for connection to establish
    log.info("Waiting for session...")
    time.sleep(5)
    
    symbol = "NIFTY-I"
    
    # Let's test a list of dates
    dates_to_test = [
        ("June 11 (Thu)", datetime(2026, 6, 11, 9, 15, 0), datetime(2026, 6, 11, 15, 30, 0)),
        ("June 12 (Fri)", datetime(2026, 6, 12, 9, 15, 0), datetime(2026, 6, 12, 15, 30, 0)),
        ("June 15 (Mon)", datetime(2026, 6, 15, 9, 15, 0), datetime(2026, 6, 15, 15, 30, 0)),
        ("June 16 (Tue)", datetime(2026, 6, 16, 9, 15, 0), datetime(2026, 6, 16, 15, 30, 0)),
    ]
    
    for label, start_dt, end_dt in dates_to_test:
        log.info(f"Querying {label} (from {start_dt} to {end_dt})...")
        try:
            raw_data = td.get_historic_data(
                symbol,
                start_time=start_dt,
                end_time=end_dt,
                bar_size="tick",
                bidask=True
            )
            log.info(f"  Result for {label}: {len(raw_data) if raw_data else 0} records.")
            if raw_data:
                log.info(f"    First record timestamp: {getattr(raw_data[0], 'timestamp', 'N/A')}")
                log.info(f"    Last record timestamp: {getattr(raw_data[-1], 'timestamp', 'N/A')}")
        except Exception as exc:
            log.exception(f"  Failed for {label}: {exc}")
            
    log.info("Disconnecting...")
    td.disconnect()

if __name__ == "__main__":
    main()
