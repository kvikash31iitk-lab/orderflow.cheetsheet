"""Central live pipeline wiring every component together.

    TrueData/sim tick
        -> TickHandler.normalise (classify aggressor side)
        -> TickRecorder (parquet) + tick DB buffer
        -> AggregatorManager (footprint candles per timeframe, runs OrderFlowEngine)
        -> on candle update: throttled WS broadcast
        -> on candle close : persist (PG + Redis) + AlertEngine + scanner update

The hot path (on_tick) only touches in-memory structures; all IO is drained by
background tasks so it stays responsive at high tick rates.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

from .alerts.alert_engine import Alert, AlertEngine
from .alerts.notifiers import Notifier
from .api.websocket import ConnectionManager
from .config import Settings, settings as default_settings, timeframe_to_ms
from .market_data.aggregator import (
    AggregatorManager,
    CandleEvent,
    consolidate_candle,
    default_row_size,
)
from .market_data.seconds_aggregator import aggregate_ticks_to_candles
from .market_data.tick_handler import TickHandler
from .market_data.websocket_client import MarketDataClient
from .orderflow.models import FootprintCandle
from .storage.postgres import PostgresRepo
from .storage.recorder import TickRecorder
from .storage.redis_cache import RedisCache
from .trading.broker import SimulatedBroker

log = logging.getLogger("pipeline")

BROADCAST_HZ = 8           # live-candle push rate
DB_FLUSH_SECONDS = 1.0
MAX_TICK_BUFFER = 200_000


class Pipeline:
    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self.handler = TickHandler()
        self.aggregator = AggregatorManager(cfg=self.cfg)
        self.pg = PostgresRepo(self.cfg)
        self.redis = RedisCache(self.cfg)
        self.recorder = TickRecorder(self.cfg)
        self.connections = ConnectionManager()
        self.notifier = Notifier(self.cfg)
        self.alerts = AlertEngine(
            notifier=self.notifier,
            on_alert=self._on_alert,
            persist=self._persist_alert,
            cfg=self.cfg,
        )
        self.client = MarketDataClient(on_tick=self._on_tick, cfg=self.cfg)
        self.broker = SimulatedBroker(self.cfg)

        self._tick_buf: list[dict] = []
        # keyed by (symbol, timeframe, row_size) so consolidation levels stay isolated
        self._live: dict[tuple[str, str, float], dict] = {}
        self._dirty: set[tuple[str, str, float]] = set()
        # latest BASE live candle object per (symbol, timeframe), used to group
        # consolidated views from on the fly (so live matches the historical group)
        self._base_live: dict[tuple[str, str], FootprintCandle] = {}
        self._scanner: dict[str, dict] = {}
        self._tasks: list[asyncio.Task] = []
        self._running = False

    # ----------------------------------------------------------------- start
    async def start(self) -> None:
        await self.pg.connect()
        await self.redis.connect()
        self._running = True
        # pre-register the default (base row-size) aggregator for every configured
        # symbol so live data + the scanner populate before any client subscribes.
        for sym in self.cfg.symbols:
            self.aggregator.ensure(sym, self.cfg.default_timeframe)
        # warm the scanner + alerts from Postgres so the panels aren't blank after a
        # restart (best-effort; never blocks startup).
        await self._prepopulate_from_db()
        self._tasks = [
            asyncio.create_task(self._broadcast_loop(), name="broadcast"),
            asyncio.create_task(self._db_flush_loop(), name="db-flush"),
            asyncio.create_task(self._status_loop(), name="status"),
        ]
        await self.client.start()
        log.info("Pipeline started (source=%s)", self.client.status.source)

    async def _prepopulate_from_db(self) -> None:
        """Warm the in-memory scanner + alerts from Postgres on boot so the panels
        aren't blank after a restart. Best-effort: any failure is logged, not raised."""
        if not self.pg.enabled:
            return
        tf = self.cfg.default_timeframe
        # scanner: the latest stored base-row candle for each configured symbol
        try:
            for sym in self.cfg.symbols:
                rows = await self.pg.recent_footprints(sym, tf, limit=1, row_size=default_row_size(sym))
                if rows:
                    self._update_scanner(FootprintCandle.from_dict(rows[0]))
        except Exception as exc:  # noqa: BLE001 - never block startup on a warm-up read
            log.warning("scanner pre-populate failed: %s", exc)
        # alerts: the most recent 100, oldest-first appendleft -> newest at the front
        try:
            for r in reversed(await self.pg.recent_alerts(limit=100)):
                payload = r.get("payload")
                self.alerts.recent.appendleft(Alert(
                    ts=r["ts"],
                    symbol=r["symbol"],
                    timeframe=r.get("timeframe") or "",
                    type=r["type"],
                    severity=r["severity"],
                    message=r["message"],
                    payload=json.loads(payload) if isinstance(payload, str) else (payload or {}),
                ))
        except Exception as exc:  # noqa: BLE001 - never block startup on a warm-up read
            log.warning("alerts pre-populate failed: %s", exc)

    async def stop(self) -> None:
        self._running = False
        await self.client.stop()
        for t in self._tasks:
            t.cancel()
        self.recorder.close()
        await self._flush_ticks()
        await self.notifier.close()
        await self.redis.close()
        await self.pg.close()

    # ------------------------------------------------------------- hot path
    async def _on_tick(self, raw: dict) -> None:
        tick = self.handler.normalise(
            raw["symbol"], raw["timestamp"], raw["price"], raw["volume"],
            raw.get("bid"), raw.get("ask"), raw.get("side"),
        )
        td = tick.to_dict()
        self.recorder.add(td)
        if len(self._tick_buf) < MAX_TICK_BUFFER:
            self._tick_buf.append(td)

        # simulated broker: fill any working limit orders this tick trades through
        self.broker.on_tick(tick)
        for ev in self.broker.drain():
            sym = ev.get("symbol")
            await self.connections.broadcast(ev, symbol=sym)

        for ev in self.aggregator.process(tick):   # base candles only
            key = (tick.symbol, ev.timeframe, ev.live.row_size)
            self._live[key] = ev.live.to_dict()
            self._base_live[(tick.symbol, ev.timeframe)] = ev.live
            self._dirty.add(key)
            if ev.closed is not None:
                await self._on_candle_close(ev)

    async def _on_candle_close(self, ev: CandleEvent) -> None:
        candle = ev.closed   # always the BASE candle (manager only runs base aggregators)
        # broadcast the finalized base candle immediately (don't wait for throttle)
        await self.connections.broadcast(
            {"type": "candle", "data": candle.to_dict()},
            symbol=candle.symbol, timeframe=candle.timeframe, replay=False,
            row_size=candle.row_size,
        )
        # the base candle is the canonical record - persist / alert / scan it once.
        if candle.row_size == default_row_size(candle.symbol):
            await self.pg.save_candle(candle)
            await self.redis.push_candle(candle.symbol, candle.timeframe, candle.to_dict())
            await self.alerts.evaluate(candle)
            self._update_scanner(candle)
        # finalized consolidated views (display-only, grouped from the base candle)
        for rs in self.aggregator.consolidations_for(candle.symbol, candle.timeframe):
            cc = consolidate_candle(candle, rs, self.cfg).to_dict()
            self._live[(candle.symbol, candle.timeframe, rs)] = cc
            await self.connections.broadcast(
                {"type": "candle", "data": cc},
                symbol=candle.symbol, timeframe=candle.timeframe, replay=False, row_size=rs,
            )

    def _update_scanner(self, candle) -> None:
        s = candle.signals
        # key per (symbol, timeframe) so the scanner shows one row per timeframe
        self._scanner[f"{candle.symbol}_{candle.timeframe}"] = {
            "symbol": candle.symbol,
            "timeframe": candle.timeframe,
            "price": candle.close,
            "delta": candle.delta,
            "cumDelta": candle.cum_delta,
            "absorption": s.absorption,
            "exhaustion": s.exhaustion,
            "lp": s.lp,
            "ad": s.ad,
            "imbalances": len(s.stacked_imbalances),
            "trend": candle.market_structure,
            "signals": s.active_labels(),
            "updated": int(time.time() * 1000),
        }

    # --------------------------------------------------------- background IO
    async def _broadcast_loop(self) -> None:
        interval = 1.0 / BROADCAST_HZ
        while self._running:
            await asyncio.sleep(interval)
            if not self._dirty:
                continue
            keys = list(self._dirty)
            self._dirty.clear()
            for (sym, tf, rs) in keys:
                data = self._live.get((sym, tf, rs))
                if data:
                    await self.connections.broadcast(
                        {"type": "candle", "data": data}, symbol=sym, timeframe=tf,
                        replay=False, row_size=rs,
                    )
                # group + broadcast the live consolidated views from the base candle
                # here (at broadcast rate, not per tick, to keep the hot path cheap)
                base = self._base_live.get((sym, tf))
                if base is not None and rs == default_row_size(sym):
                    for crs in self.aggregator.consolidations_for(sym, tf):
                        cc = consolidate_candle(base, crs, self.cfg).to_dict()
                        self._live[(sym, tf, crs)] = cc
                        await self.connections.broadcast(
                            {"type": "candle", "data": cc}, symbol=sym, timeframe=tf,
                            replay=False, row_size=crs,
                        )

    async def _db_flush_loop(self) -> None:
        while self._running:
            await asyncio.sleep(DB_FLUSH_SECONDS)
            await self._flush_ticks()
            self.recorder.flush()

    async def _flush_ticks(self) -> None:
        if not self._tick_buf:
            return
        batch, self._tick_buf = self._tick_buf, []
        await self.pg.insert_ticks(batch)

    async def _status_loop(self) -> None:
        while self._running:
            await asyncio.sleep(1.0)
            status = self.status()
            await self.redis.set_status(status)
            await self.connections.broadcast({"type": "status", "data": status})
            # stream live position PnL (floating with the latest price) once a second
            if self.broker.positions:
                for msg in self.broker.position_messages():
                    sym = msg.get("symbol")
                    await self.connections.broadcast(msg, symbol=sym)

    # ----------------------------------------------------------- alert sinks
    async def _on_alert(self, alert: Alert) -> None:
        await self.connections.broadcast({"type": "alert", "data": alert.to_dict()})

    async def _persist_alert(self, alert: dict) -> None:
        await self.pg.insert_alert(alert)

    # ------------------------------------------------------------- accessors
    def status(self) -> dict:
        st = self.client.status.to_dict()
        st["clients"] = self.connections.count
        st["pgEnabled"] = self.pg.enabled
        st["redisEnabled"] = self.redis.enabled
        return st

    async def snapshot(self, symbol: str, timeframe: str, limit: int = 200,
                       row_size: Optional[float] = None, cells: bool = True) -> list[dict]:
        """Historical candles for initial chart load.

        Loads database candles from Postgres, merges them with hot cache candles from
        Redis (where newer Redis candles overwrite or append to Postgres rows), and
        appends the live/open candle in memory.

        cells=False returns a candle-only payload (per-price footprint cells dropped) -
        a full-cells 15k snapshot is ~40MB, but candle mode never renders the cells, so
        the default chart load stays small/fast. Footprint mode requests cells=True.
        """
        base = default_row_size(symbol)
        rs = row_size if row_size is not None else base

        # 1. Fetch historical closed footprints from Postgres (up to limit)
        stored = await self.pg.recent_footprints(symbol, timeframe, limit, row_size=base)
        if rs == base:
            rows = stored
        else:
            rows = [consolidate_candle(FootprintCandle.from_dict(r), rs, self.cfg).to_dict() for r in stored]

        # 2. Fetch hot cache candles from Redis (up to limit) and merge
        cached = await self.redis.get_candles(symbol, timeframe, limit)
        if cached and len(cached) > 0:
            if rs != base:
                cached = [consolidate_candle(FootprintCandle.from_dict(c), rs, self.cfg).to_dict() for c in cached]

            # Merge by startTime (newer cached candles overwrite)
            merged = {r["startTime"]: r for r in rows}
            for c in cached:
                if c.get("rowSize") == rs:
                    merged[c["startTime"]] = c
            rows = sorted(merged.values(), key=lambda x: x["startTime"])[-limit:]

        # 3. Append the active live/open candle currently forming in memory
        live = self._live.get((symbol, timeframe, rs))
        if live and (not rows or rows[-1]["startTime"] != live["startTime"]):
            rows.append(live)

        # candle-only payload: strip the heavy per-price cells. Copy each row (don't
        # mutate) because the live candle dict is shared in memory with other consumers.
        if not cells:
            rows = [{**r, "cells": []} for r in rows]

        return rows

    async def snapshot_seconds(self, symbol: str, timeframe: str, limit: int = 25000,
                               row_size: Optional[float] = None, cells: bool = False) -> list[dict]:
        """On-demand sub-minute (e.g. 5s) footprint candles, reconstructed from the
        stored `ticks` table (NOT from persisted minute candles — seconds bars are never
        persisted). Bounded: we only rebuild the most-recent `limit` buckets, and the
        underlying tick scan is capped (settings.seconds_tick_fetch_cap). Returns the last
        `limit` candles oldest-first.

        Used by indicator lower-timeframe orderflow (SC1 V4's 5S child bars). cells default
        False — callers want the orderflow scalars (totalAskVolume/totalBidVolume/delta),
        not per-price rows.
        """
        bucket_ms = timeframe_to_ms(timeframe)
        if not bucket_ms or bucket_ms <= 0:
            return []
        rs = row_size if row_size is not None else default_row_size(symbol)
        rng = await self.pg.ticks_minmax(symbol)
        if rng is None:
            return []
        min_ts, max_ts = rng
        # window = the most-recent `limit` buckets; floor at the first stored tick.
        since = max(min_ts, max_ts - limit * bucket_ms)
        ticks = await self.pg.recent_ticks(symbol, since, limit=self.cfg.seconds_tick_fetch_cap)
        if not ticks:
            return []
        candles = aggregate_ticks_to_candles(ticks, symbol, timeframe, bucket_ms, rs)
        rows = [c.to_dict() for c in candles][-limit:]
        if not cells:
            rows = [{**r, "cells": []} for r in rows]
        return rows

    def scanner(self) -> list[dict]:
        rows = list(self._scanner.values())
        rows.sort(key=lambda r: len(r["signals"]), reverse=True)
        return rows

    def recent_alerts(self) -> list[dict]:
        return [a.to_dict() for a in self.alerts.recent]
