"""Multi-timeframe scanner rows (one row per symbol+timeframe, no collision)."""
import pytest

# Pipeline pulls the full storage/alert stack; skip cleanly if those deps are absent.
pytest.importorskip("asyncpg")
pytest.importorskip("httpx")
pytest.importorskip("redis")

from app.config import settings
from app.orderflow.models import FootprintCandle
from app.pipeline import Pipeline


def _candle(symbol, timeframe):
    return FootprintCandle(
        symbol=symbol, timeframe=timeframe, start_time=0, end_time=120000, row_size=1.0, close=100.0
    )


def test_scanner_keys_by_symbol_and_timeframe():
    p = Pipeline(settings)
    p._update_scanner(_candle("NIFTY-I", "2m"))
    p._update_scanner(_candle("NIFTY-I", "5m"))      # same symbol, different tf
    p._update_scanner(_candle("BANKNIFTY-I", "2m"))
    rows = p.scanner()
    keys = {(r["symbol"], r["timeframe"]) for r in rows}
    assert keys == {("NIFTY-I", "2m"), ("NIFTY-I", "5m"), ("BANKNIFTY-I", "2m")}
    assert len(rows) == 3   # NIFTY 2m and 5m are SEPARATE rows (would collide under old keying)
