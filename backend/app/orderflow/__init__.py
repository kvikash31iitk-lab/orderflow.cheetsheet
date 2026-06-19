"""Order-flow analytics engine.

Pipeline (see engine.py):
    Tick -> classify side -> footprint cells -> per-candle metrics ->
    delta / cumulative delta -> imbalance / stacked imbalance ->
    absorption / exhaustion / LP / AD -> volume nodes -> market structure.

Everything is pure-Python + numpy so it can run inside the async ingest loop
without blocking, and is independently unit-testable.
"""
from .models import (
    Tick,
    TradeSide,
    FootprintCell,
    FootprintCandle,
    Signals,
    ImbalanceZone,
)
from .engine import OrderFlowEngine

__all__ = [
    "Tick",
    "TradeSide",
    "FootprintCell",
    "FootprintCandle",
    "Signals",
    "ImbalanceZone",
    "OrderFlowEngine",
]
