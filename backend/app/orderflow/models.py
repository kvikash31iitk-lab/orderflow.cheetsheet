"""Core data models for the order-flow engine.

Plain dataclasses (not pydantic) are used on the hot path for speed; every model
exposes `to_dict()` producing JSON-ready primitives that match the frontend
TypeScript contract in `frontend/src/types/orderflow.ts`.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Optional

# Decimal places for serialising PRICES on the wire. 9 = Databento's native
# fixed-point resolution (1e-9), enough for sub-tick FX grids like 6E (row 0.00005,
# needs 5 dp). For any instrument whose grid has <= 4 decimals this is identical to
# the previous round(_, 4), so existing (TrueData / ES / GC / equities) payloads are
# byte-for-byte unchanged.
_PRICE_DP = 9


class TradeSide(str, enum.Enum):
    BUY = "BUY"        # aggressive buyer lifted the ask  (price >= ask)
    SELL = "SELL"      # aggressive seller hit the bid     (price <= bid)
    NEUTRAL = "NEUTRAL"  # between bid/ask, or quotes unknown -> tick rule fallback


@dataclass(slots=True)
class Tick:
    """A single normalised trade print with the prevailing top-of-book quote."""
    symbol: str
    timestamp: int          # epoch milliseconds
    price: float
    volume: float
    bid: Optional[float] = None
    ask: Optional[float] = None
    side: TradeSide = TradeSide.NEUTRAL

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "timestamp": self.timestamp,
            "price": self.price,
            "volume": self.volume,
            "bid": self.bid,
            "ask": self.ask,
            "side": self.side.value,
        }


@dataclass(slots=True)
class FootprintCell:
    """One price row inside a footprint candle: bid (sell) vol x ask (buy) vol."""
    price: float
    bid_volume: float = 0.0   # executed at/below bid => aggressive SELL
    ask_volume: float = 0.0   # executed at/above ask => aggressive BUY
    buy_imbalance: bool = False    # ask_volume dominates -> bullish cell
    sell_imbalance: bool = False   # bid_volume dominates -> bearish cell

    @property
    def delta(self) -> float:
        return self.ask_volume - self.bid_volume

    @property
    def total(self) -> float:
        return self.ask_volume + self.bid_volume

    def to_dict(self) -> dict:
        return {
            "price": round(self.price, _PRICE_DP),
            "bidVolume": self.bid_volume,
            "askVolume": self.ask_volume,
            "delta": self.delta,
            "total": self.total,
            "buyImbalance": self.buy_imbalance,
            "sellImbalance": self.sell_imbalance,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FootprintCell":
        c = cls(price=d["price"], bid_volume=d.get("bidVolume", 0.0), ask_volume=d.get("askVolume", 0.0))
        c.buy_imbalance = d.get("buyImbalance", False)
        c.sell_imbalance = d.get("sellImbalance", False)
        return c


@dataclass(slots=True)
class ImbalanceZone:
    """A run of >= N consecutive same-direction imbalanced cells."""
    direction: str          # "bullish" | "bearish"
    start_price: float
    end_price: float
    count: int

    def to_dict(self) -> dict:
        return {
            "direction": self.direction,
            "startPrice": round(self.start_price, _PRICE_DP),
            "endPrice": round(self.end_price, _PRICE_DP),
            "count": self.count,
        }


@dataclass(slots=True)
class Signals:
    """All derived signals attached to a finished footprint candle."""
    absorption: bool = False
    absorption_price: Optional[float] = None
    absorption_side: Optional[str] = None        # "bid" | "ask"

    exhaustion: bool = False
    exhaustion_type: Optional[str] = None        # "high" | "low"

    lp: bool = False
    lp_side: Optional[str] = None                # "support" | "resistance"
    lp_price: Optional[float] = None

    ad: bool = False
    ad_value: float = 0.0                        # the delta that triggered it

    delta_spike: bool = False
    volume_spike: bool = False
    hvn: list[float] = field(default_factory=list)   # high-volume-node prices
    lvn: list[float] = field(default_factory=list)   # low-volume-node prices
    volume_cluster: bool = False

    delta_divergence: bool = False
    delta_divergence_side: Optional[str] = None      # "bullish" | "bearish"

    stacked_imbalances: list[ImbalanceZone] = field(default_factory=list)
    # Stateful horizontal stacked-imbalance zones tracked across candles by the
    # engine: each dict has direction, start_price, end_price, start_time,
    # mitigated, mitigation_time. Snapshot of the engine's live zone state.
    active_zones: list[dict] = field(default_factory=list)

    def active_labels(self) -> list[str]:
        """Short labels for alerting / scanner (only firing signals)."""
        out: list[str] = []
        if self.absorption:
            out.append("ABSORPTION")
        if self.exhaustion:
            out.append("EXHAUSTION")
        if self.lp:
            out.append("LP")
        if self.ad:
            out.append("AD")
        if self.delta_spike:
            out.append("DELTA_SPIKE")
        if self.volume_spike:
            out.append("VOLUME_SPIKE")
        if self.stacked_imbalances:
            out.append("STACKED_IMBALANCE")
        if self.delta_divergence:
            out.append("DELTA_DIVERGENCE")
        if self.hvn:
            out.append("HVN")
        if self.lvn:
            out.append("LVN")
        return out

    def to_dict(self) -> dict:
        return {
            "absorption": self.absorption,
            "absorptionPrice": self.absorption_price,
            "absorptionSide": self.absorption_side,
            "exhaustion": self.exhaustion,
            "exhaustionType": self.exhaustion_type,
            "lp": self.lp,
            "lpSide": self.lp_side,
            "lpPrice": self.lp_price,
            "ad": self.ad,
            "adValue": self.ad_value,
            "deltaSpike": self.delta_spike,
            "volumeSpike": self.volume_spike,
            "hvn": [round(p, _PRICE_DP) for p in self.hvn],
            "lvn": [round(p, _PRICE_DP) for p in self.lvn],
            "volumeCluster": self.volume_cluster,
            "deltaDivergence": self.delta_divergence,
            "deltaDivergenceSide": self.delta_divergence_side,
            "stackedImbalances": [z.to_dict() for z in self.stacked_imbalances],
            "activeZones": [
                {
                    "direction": z["direction"],
                    "startPrice": round(z["start_price"], _PRICE_DP),
                    "endPrice": round(z["end_price"], _PRICE_DP),
                    "startTime": z["start_time"],
                    "mitigated": z["mitigated"],
                    "mitigationTime": z["mitigation_time"],
                }
                for z in self.active_zones
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Signals":
        """Rebuild from the camelCase wire/DB form (inverse of to_dict)."""
        s = cls()
        s.absorption = d.get("absorption", False)
        s.absorption_price = d.get("absorptionPrice")
        s.absorption_side = d.get("absorptionSide")
        s.exhaustion = d.get("exhaustion", False)
        s.exhaustion_type = d.get("exhaustionType")
        s.lp = d.get("lp", False)
        s.lp_side = d.get("lpSide")
        s.lp_price = d.get("lpPrice")
        s.ad = d.get("ad", False)
        s.ad_value = d.get("adValue", 0.0)
        s.delta_spike = d.get("deltaSpike", False)
        s.volume_spike = d.get("volumeSpike", False)
        s.hvn = list(d.get("hvn", []))
        s.lvn = list(d.get("lvn", []))
        s.volume_cluster = d.get("volumeCluster", False)
        s.delta_divergence = d.get("deltaDivergence", False)
        s.delta_divergence_side = d.get("deltaDivergenceSide")
        return s


@dataclass(slots=True)
class FootprintCandle:
    """A time-bucketed footprint candle: OHLC + per-price bid/ask volume + signals."""
    symbol: str
    timeframe: str
    start_time: int            # epoch ms (bucket start)
    end_time: int              # epoch ms (bucket start + tf, exclusive)
    row_size: float            # price granularity of a footprint row

    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0

    cells: dict[float, FootprintCell] = field(default_factory=dict)

    # rolling / cross-candle metrics filled by the engine / aggregator
    cum_delta: float = 0.0
    vwap: Optional[float] = None               # running daily session VWAP
    vwap_sd1_upper: Optional[float] = None     # VWAP +/- 1 standard deviation
    vwap_sd1_lower: Optional[float] = None
    vwap_sd2_upper: Optional[float] = None     # VWAP +/- 2 standard deviations
    vwap_sd2_lower: Optional[float] = None
    max_delta: float = 0.0                     # peak intra-candle running delta
    min_delta: float = 0.0                     # trough intra-candle running delta
    market_structure: Optional[str] = None     # "HH" | "HL" | "LH" | "LL"
    signals: Signals = field(default_factory=Signals)

    closed: bool = False
    tick_count: int = 0

    # ---- intra-candle aggregates ----
    @property
    def total_ask_volume(self) -> float:
        return sum(c.ask_volume for c in self.cells.values())

    @property
    def total_bid_volume(self) -> float:
        return sum(c.bid_volume for c in self.cells.values())

    @property
    def total_volume(self) -> float:
        return self.total_ask_volume + self.total_bid_volume

    @property
    def delta(self) -> float:
        return self.total_ask_volume - self.total_bid_volume

    @property
    def poc(self) -> Optional[float]:
        """Point of Control: price row with the greatest total volume."""
        if not self.cells:
            return None
        return max(self.cells.values(), key=lambda c: c.total).price

    def sorted_cells(self) -> list[FootprintCell]:
        """Cells from highest price (top of candle) to lowest, GoCharting-style."""
        return [self.cells[p] for p in sorted(self.cells, reverse=True)]

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "rowSize": self.row_size,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "cells": [c.to_dict() for c in self.sorted_cells()],
            "totalVolume": self.total_volume,
            "totalAskVolume": self.total_ask_volume,
            "totalBidVolume": self.total_bid_volume,
            "delta": self.delta,
            "cumDelta": self.cum_delta,
            "vwap": self.vwap,
            "vwapSd1Upper": self.vwap_sd1_upper,
            "vwapSd1Lower": self.vwap_sd1_lower,
            "vwapSd2Upper": self.vwap_sd2_upper,
            "vwapSd2Lower": self.vwap_sd2_lower,
            "maxDelta": self.max_delta,
            "minDelta": self.min_delta,
            "poc": self.poc,
            "marketStructure": self.market_structure,
            "signals": self.signals.to_dict(),
            "closed": self.closed,
            "tickCount": self.tick_count,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FootprintCandle":
        """Reconstruct a candle from its stored/wire dict (for research replays)."""
        c = cls(
            symbol=d["symbol"], timeframe=d["timeframe"],
            start_time=d["startTime"], end_time=d["endTime"],
            row_size=d.get("rowSize", 1.0),
        )
        c.open = d.get("open", 0.0)
        c.high = d.get("high", 0.0)
        c.low = d.get("low", 0.0)
        c.close = d.get("close", 0.0)
        c.cum_delta = d.get("cumDelta", 0.0)
        c.vwap = d.get("vwap")
        c.vwap_sd1_upper = d.get("vwapSd1Upper")
        c.vwap_sd1_lower = d.get("vwapSd1Lower")
        c.vwap_sd2_upper = d.get("vwapSd2Upper")
        c.vwap_sd2_lower = d.get("vwapSd2Lower")
        c.max_delta = d.get("maxDelta", 0.0)
        c.min_delta = d.get("minDelta", 0.0)
        c.market_structure = d.get("marketStructure")
        c.closed = d.get("closed", True)
        c.tick_count = d.get("tickCount", 0)
        for cd in d.get("cells", []):
            cell = FootprintCell.from_dict(cd)
            c.cells[cell.price] = cell
        c.signals = Signals.from_dict(d.get("signals", {}))
        return c
