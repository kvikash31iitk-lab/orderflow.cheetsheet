"""Market data ingest: TrueData feed -> normalised ticks -> footprint candles."""
from .tick_handler import TickHandler, classify_side
from .aggregator import (
    Aggregator,
    AggregatorManager,
    default_row_size,
    get_symbol_config,
    SYMBOL_CONFIG,
)
from .websocket_client import MarketDataClient
from .databento_client import DatabentoClient

__all__ = [
    "TickHandler",
    "classify_side",
    "Aggregator",
    "AggregatorManager",
    "default_row_size",
    "get_symbol_config",
    "SYMBOL_CONFIG",
    "MarketDataClient",
    "DatabentoClient",
]
