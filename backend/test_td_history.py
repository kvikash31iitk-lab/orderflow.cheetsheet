import time
import logging
from truedata_ws.websocket.TD import TD
from app.config import settings
from app.market_data.websocket_client import _history_record_to_raw

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("test_td_history")

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
    log.info(f"Querying historical ticks for {symbol}...")
    try:
        # Fetch 5 days duration
        raw_data = td.get_historic_data(symbol, duration="5 D", bar_size="tick", bidask=True)
        log.info(f"Received {len(raw_data) if raw_data else 0} raw records from TrueData.")
        
        if raw_data:
            # Let's map a few to verify
            mapped_records = []
            for rec in raw_data[:5]:
                mapped = _history_record_to_raw(rec, symbol)
                mapped_records.append(mapped)
            
            log.info("First 5 mapped records:")
            for idx, mr in enumerate(mapped_records):
                log.info(f"  [{idx}] {mr}")
                
            last_mapped = _history_record_to_raw(raw_data[-1], symbol)
            log.info(f"Last mapped record: {last_mapped}")
    except Exception as exc:
        log.exception(f"Error fetching history: {exc}")
    finally:
        log.info("Disconnecting...")
        td.disconnect()

if __name__ == "__main__":
    main()
