"""Replay recorded ticks through the order-flow engine at 1x..50x or step-by-step.

A replay runs an isolated AggregatorManager so it never touches live state. Output
candles are broadcast with {"type": "candle", "data": {... , "replay": true}} plus
periodic {"type": "replay", "data": {progress, playing, speed}} control frames.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Optional

from ..config import Settings, settings as default_settings
from ..market_data.aggregator import AggregatorManager
from ..market_data.tick_handler import TickHandler
from ..orderflow.models import Tick, TradeSide

# These are duck-typed at runtime and only referenced in annotations, so importing
# them lazily keeps the replay engine decoupled from fastapi/asyncpg (testable with
# fakes, importable without the full server stack).
if TYPE_CHECKING:
    from ..api.websocket import ConnectionManager
    from ..market_data.websocket_client import MarketDataClient
    from ..storage.postgres import PostgresRepo

log = logging.getLogger("replay")

ALLOWED_SPEEDS = (1, 2, 5, 10, 50)


class ReplayEngine:
    def __init__(
        self,
        pg: PostgresRepo,
        connections: ConnectionManager,
        cfg: Optional[Settings] = None,
        client: Optional[MarketDataClient] = None,
    ) -> None:
        self.cfg = cfg or default_settings
        self.pg = pg
        self.connections = connections
        self.client = client                # live feed client, used for backfill

        self._ticks: list[dict] = []
        self._idx = 0
        self._symbol = ""
        self._timeframe = self.cfg.default_timeframe
        self._agg: Optional[AggregatorManager] = None
        self._handler = TickHandler()
        self.speed = 1
        self.playing = False
        self._task: Optional[asyncio.Task] = None

    async def load(self, symbol: str, start_ms: int, end_ms: int, timeframe: str) -> int:
        await self._cancel()   # cleanup without emitting an "exit" frame
        self._symbol = symbol.upper()
        self._timeframe = timeframe
        self._handler = TickHandler()       # fresh classifier for this load/backfill
        self._ticks = await self.pg.ticks_range(self._symbol, start_ms, end_ms)

        # No local recording for this window -> backfill from TrueData history.
        if not self._ticks and self.client is not None:
            hours = max(1, (end_ms - start_ms) // 3_600_000)
            duration_str = f"{hours} H"
            raw_ticks = await self.client.get_history(self._symbol, duration=duration_str, bar_size="tick")
            ticks_to_save: list[dict] = []
            for t in raw_ticks:
                tick = self._handler.normalise(
                    t["symbol"], t["timestamp"], t["price"], t["volume"], t.get("bid"), t.get("ask")
                )
                ticks_to_save.append(tick.to_dict())
            if ticks_to_save:
                await self.pg.insert_ticks(ticks_to_save)
                self._ticks = await self.pg.ticks_range(self._symbol, start_ms, end_ms)
            log.info("Replay backfilled %d ticks for %s (%s)", len(ticks_to_save), self._symbol, duration_str)

        self._idx = 0
        self._agg = AggregatorManager(timeframes=[timeframe], cfg=self.cfg)
        # register the (base row-size) aggregator so process() fans ticks into it
        self._agg.ensure(self._symbol, timeframe)
        log.info("Replay loaded %d ticks for %s", len(self._ticks), self._symbol)
        return len(self._ticks)

    def _row_to_tick(self, r: dict) -> Tick:
        # Reuse stored side if present; otherwise reclassify.
        side = r.get("side")
        if side:
            return Tick(
                symbol=r["symbol"], timestamp=r["ts"], price=r["price"], volume=r["volume"],
                bid=r.get("bid"), ask=r.get("ask"), side=TradeSide(side),
            )
        return self._handler.normalise(
            r["symbol"], r["ts"], r["price"], r["volume"], r.get("bid"), r.get("ask"))

    async def _emit(self, ev) -> None:
        live = ev.live.to_dict()
        live["replay"] = True
        await self.connections.broadcast(
            {"type": "candle", "data": live},
            symbol=self._symbol, timeframe=self._timeframe, replay=True,
        )

    async def step(self) -> bool:
        """Advance until the current candle closes (one footprint candle forward)."""
        if not self._agg or self._idx >= len(self._ticks):
            return False
        while self._idx < len(self._ticks):
            tick = self._row_to_tick(self._ticks[self._idx])
            self._idx += 1
            events = self._agg.process(tick)
            for ev in events:
                await self._emit(ev)
                if ev.closed is not None:
                    await self._progress()
                    return True
        await self._progress()
        return False

    async def play(self, speed: int = 1) -> None:
        if speed not in ALLOWED_SPEEDS:
            speed = min(ALLOWED_SPEEDS, key=lambda s: abs(s - speed))
        self.speed = speed
        if self.playing:
            return
        self.playing = True
        self._task = asyncio.create_task(self._run(), name="replay-run")

    async def _run(self) -> None:
        prev_ts: Optional[int] = None
        while self.playing and self._idx < len(self._ticks):
            row = self._ticks[self._idx]
            if prev_ts is not None:
                wait = (row["ts"] - prev_ts) / 1000.0 / self.speed
                if wait > 0:
                    await asyncio.sleep(min(wait, 1.0))
            prev_ts = row["ts"]
            tick = self._row_to_tick(row)
            self._idx += 1
            for ev in self._agg.process(tick):
                await self._emit(ev)
            if self._idx % 250 == 0:
                await self._progress()
        self.playing = False
        await self._progress()

    async def pause(self) -> None:
        self.playing = False
        if self._task:
            await asyncio.sleep(0)  # let the loop observe the flag

    async def _cancel(self) -> None:
        """Cancel any running playback without notifying clients (used by load)."""
        self.playing = False
        if self._task:
            self._task.cancel()
            self._task = None

    async def stop(self) -> None:
        await self._cancel()
        # tell the replay client the session has ended so it can resync to live
        if self.connections is not None:
            await self.connections.broadcast({"type": "replay", "data": {
                "symbol": self._symbol, "timeframe": self._timeframe,
                "index": self._idx, "total": 0, "progress": 0.0,
                "playing": False, "speed": self.speed,
                "exit": True, "ts": int(time.time() * 1000),
            }}, replay=True)

    async def _progress(self) -> None:
        total = max(len(self._ticks), 1)
        await self.connections.broadcast({"type": "replay", "data": {
            "symbol": self._symbol, "timeframe": self._timeframe,
            "index": self._idx, "total": len(self._ticks),
            "progress": round(self._idx / total, 4),
            "playing": self.playing, "speed": self.speed,
            "ts": int(time.time() * 1000),
        }}, replay=True)
