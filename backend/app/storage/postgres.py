"""Async PostgreSQL repository (asyncpg).

Degrades gracefully: if the DB is unreachable, `enabled` stays False and every
write becomes a no-op so the live terminal keeps running. Reads return [].
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

import asyncpg

from ..config import Settings, settings as default_settings
from ..orderflow.models import FootprintCandle
from ..orderflow.research import evaluate_signal

log = logging.getLogger("storage.postgres")
_SCHEMA = Path(__file__).with_name("schema.sql")

# Only these signal tables carry mae/mfe/outcome columns; whitelist guards the
# table name (which must be interpolated since asyncpg can't parameterise it).
_SIGNAL_TABLES = ("lp_signals", "ad_signals")


def _signal_side_from_row(kind: str, row: dict) -> Optional[str]:
    """Map a stored signal row to the implied trade direction for MAE/MFE."""
    if kind == "LP":
        side = row.get("side")
        return {"support": "long", "resistance": "short"}.get(side)
    if kind == "AD":
        dv = row.get("delta_value") or 0.0
        return "long" if dv > 0 else "short" if dv < 0 else None
    return None


class PostgresRepo:
    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self.pool: Optional[asyncpg.Pool] = None
        self.enabled = False

    async def connect(self, retries: int = 10, delay: float = 2.0) -> None:
        for attempt in range(1, retries + 1):
            try:
                self.pool = await asyncpg.create_pool(
                    dsn=self.cfg.postgres_dsn, min_size=1, max_size=8, command_timeout=30
                )
                await self._ensure_schema()
                self.enabled = True
                log.info("PostgreSQL connected (%s)", self.cfg.postgres_host)
                return
            except Exception as exc:
                log.warning("PG connect attempt %d/%d failed: %s", attempt, retries, exc)
                await asyncio.sleep(delay)
        log.error("PostgreSQL unavailable — running without durable storage.")

    async def _ensure_schema(self) -> None:
        if self.pool is None or not _SCHEMA.exists():
            return
        async with self.pool.acquire() as con:
            await con.execute(_SCHEMA.read_text(encoding="utf-8"))

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()

    # ---------------------------------------------------------------- writes
    async def insert_ticks(self, rows: list[dict]) -> None:
        if not self.enabled or not rows:
            return
        records = [
            (r["symbol"], r["timestamp"], r["price"], r["volume"],
             r.get("bid"), r.get("ask"), r.get("side", "NEUTRAL"))
            for r in rows
        ]
        async with self.pool.acquire() as con:
            await con.executemany(
                "INSERT INTO ticks(symbol, ts, price, volume, bid, ask, side) "
                "VALUES($1,$2,$3,$4,$5,$6,$7)",
                records,
            )

    async def save_candle(self, c: FootprintCandle) -> None:
        if not self.enabled:
            return
        d = c.to_dict()
        async with self.pool.acquire() as con, con.transaction():
            await con.execute(
                """
                INSERT INTO footprints(symbol,timeframe,start_time,end_time,row_size,
                    open,high,low,close,total_volume,bid_volume,ask_volume,delta,cum_delta,
                    poc,market_structure,cells,signals)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
                ON CONFLICT(symbol,timeframe,start_time,row_size) DO UPDATE SET
                    end_time=EXCLUDED.end_time, open=EXCLUDED.open, high=EXCLUDED.high,
                    low=EXCLUDED.low, close=EXCLUDED.close, total_volume=EXCLUDED.total_volume,
                    bid_volume=EXCLUDED.bid_volume, ask_volume=EXCLUDED.ask_volume,
                    delta=EXCLUDED.delta, cum_delta=EXCLUDED.cum_delta, poc=EXCLUDED.poc,
                    market_structure=EXCLUDED.market_structure, cells=EXCLUDED.cells,
                    signals=EXCLUDED.signals
                """,
                c.symbol, c.timeframe, c.start_time, c.end_time, c.row_size,
                c.open, c.high, c.low, c.close, c.total_volume, c.total_bid_volume,
                c.total_ask_volume, c.delta, c.cum_delta, c.poc, c.market_structure,
                json.dumps(d["cells"]), json.dumps(d["signals"]),
            )
            await self._save_signals(con, c)

    async def _save_signals(self, con, c: FootprintCandle) -> None:
        s = c.signals
        if s.absorption:
            await con.execute(
                "INSERT INTO absorption(symbol,timeframe,start_time,price,side) VALUES($1,$2,$3,$4,$5)",
                c.symbol, c.timeframe, c.start_time, s.absorption_price, s.absorption_side)
        if s.exhaustion:
            await con.execute(
                "INSERT INTO exhaustion(symbol,timeframe,start_time,kind) VALUES($1,$2,$3,$4)",
                c.symbol, c.timeframe, c.start_time, s.exhaustion_type)
        if s.lp:
            await con.execute(
                "INSERT INTO lp_signals(symbol,timeframe,start_time,side,price) VALUES($1,$2,$3,$4,$5)",
                c.symbol, c.timeframe, c.start_time, s.lp_side, s.lp_price)
        if s.ad:
            await con.execute(
                "INSERT INTO ad_signals(symbol,timeframe,start_time,delta_value) VALUES($1,$2,$3,$4)",
                c.symbol, c.timeframe, c.start_time, s.ad_value)
        for z in s.stacked_imbalances:
            await con.execute(
                "INSERT INTO imbalances(symbol,timeframe,start_time,direction,start_price,end_price,cell_count) "
                "VALUES($1,$2,$3,$4,$5,$6,$7)",
                c.symbol, c.timeframe, c.start_time, z.direction, z.start_price, z.end_price, z.count)
        await con.execute(
            "INSERT INTO delta(symbol,timeframe,start_time,delta) VALUES($1,$2,$3,$4) "
            "ON CONFLICT(symbol,timeframe,start_time) DO UPDATE SET delta=EXCLUDED.delta",
            c.symbol, c.timeframe, c.start_time, c.delta)
        await con.execute(
            "INSERT INTO cum_delta(symbol,timeframe,start_time,cum_delta) VALUES($1,$2,$3,$4) "
            "ON CONFLICT(symbol,timeframe,start_time) DO UPDATE SET cum_delta=EXCLUDED.cum_delta",
            c.symbol, c.timeframe, c.start_time, c.cum_delta)

    async def insert_alert(self, alert: dict) -> None:
        if not self.enabled:
            return
        async with self.pool.acquire() as con:
            await con.execute(
                "INSERT INTO alerts(ts,symbol,timeframe,type,severity,message,payload) "
                "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
                alert["ts"], alert["symbol"], alert.get("timeframe"), alert["type"],
                alert.get("severity", "info"), alert["message"],
                json.dumps(alert.get("payload", {})))

    # ----------------------------------------------------------------- reads
    async def recent_footprints(self, symbol: str, timeframe: str, limit: int = 200, row_size: Optional[float] = None) -> list[dict]:
        if not self.enabled:
            return []
        async with self.pool.acquire() as con:
            if row_size is not None:
                rows = await con.fetch(
                    "SELECT cells, signals, symbol, timeframe, start_time, end_time, row_size, "
                    "open, high, low, close, total_volume, bid_volume, ask_volume, delta, cum_delta, "
                    "poc, market_structure FROM footprints "
                    "WHERE symbol=$1 AND timeframe=$2 AND row_size=$3 ORDER BY start_time DESC LIMIT $4",
                    symbol, timeframe, row_size, limit)
            else:
                rows = await con.fetch(
                    "SELECT cells, signals, symbol, timeframe, start_time, end_time, row_size, "
                    "open, high, low, close, total_volume, bid_volume, ask_volume, delta, cum_delta, "
                    "poc, market_structure FROM footprints "
                    "WHERE symbol=$1 AND timeframe=$2 ORDER BY start_time DESC LIMIT $3",
                    symbol, timeframe, limit)
        return [self._row_to_candle_dict(r) for r in reversed(rows)]

    @staticmethod
    def _rows_to_range_dicts(rows) -> list[dict]:
        # rows come newest-first (DESC); reverse to ascending. Built off the event loop.
        return [{
            "symbol": r["symbol"], "timeframe": r["timeframe"],
            "startTime": r["start_time"], "endTime": r["end_time"], "rowSize": r["row_size"],
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "totalVolume": r["total_volume"], "totalBidVolume": r["bid_volume"],
            "totalAskVolume": r["ask_volume"], "delta": r["delta"], "cumDelta": r["cum_delta"],
            "poc": r["poc"], "closed": True,
        } for r in reversed(rows)]

    async def footprints_range(self, symbol: str, timeframe: str, start_ms: int, end_ms: int,
                               row_size: Optional[float] = None, limit: int = 2_000_000) -> list[dict]:
        """Closed candles in [start_ms, end_ms], ascending — for date-range/large-dataset
        research. Fetches the MOST-RECENT `limit` bars in the range (DESC LIMIT, reversed),
        so capping a huge range keeps recent data, not stale oldest data. Selects only the
        columns the SC1 engine needs (no cells ladders), and builds the dicts off the event
        loop (up to ~250k rows) so the live feed isn't stalled."""
        if not self.enabled:
            return []
        cols = ("symbol, timeframe, start_time, end_time, row_size, open, high, low, close, "
                "total_volume, bid_volume, ask_volume, delta, cum_delta, poc")
        async with self.pool.acquire() as con:
            if row_size is not None:
                rows = await con.fetch(
                    f"SELECT {cols} FROM footprints WHERE symbol=$1 AND timeframe=$2 AND row_size=$3 "
                    "AND start_time BETWEEN $4 AND $5 ORDER BY start_time DESC LIMIT $6",
                    symbol, timeframe, row_size, start_ms, end_ms, limit)
            else:
                rows = await con.fetch(
                    f"SELECT {cols} FROM footprints WHERE symbol=$1 AND timeframe=$2 "
                    "AND start_time BETWEEN $3 AND $4 ORDER BY start_time DESC LIMIT $5",
                    symbol, timeframe, start_ms, end_ms, limit)
        return await asyncio.to_thread(self._rows_to_range_dicts, rows)

    async def footprints_minmax(self, symbol: str, timeframe: str, row_size: Optional[float] = None) -> Optional[dict]:
        """(min_start, max_start, count) of stored candles for a symbol+timeframe."""
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            if row_size is not None:
                row = await con.fetchrow(
                    "SELECT min(start_time) lo, max(start_time) hi, count(*) n FROM footprints "
                    "WHERE symbol=$1 AND timeframe=$2 AND row_size=$3", symbol, timeframe, row_size)
            else:
                row = await con.fetchrow(
                    "SELECT min(start_time) lo, max(start_time) hi, count(*) n FROM footprints "
                    "WHERE symbol=$1 AND timeframe=$2", symbol, timeframe)
        if not row or row["lo"] is None:
            return None
        return {"minStart": int(row["lo"]), "maxStart": int(row["hi"]), "count": int(row["n"])}

    async def ticks_range(self, symbol: str, start_ms: int, end_ms: int, limit: int = 500_000) -> list[dict]:
        if not self.enabled:
            return []
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "SELECT symbol, ts, price, volume, bid, ask, side FROM ticks "
                "WHERE symbol=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts LIMIT $4",
                symbol, start_ms, end_ms, limit)
        return [dict(r) for r in rows]

    async def ticks_minmax(self, symbol: str) -> Optional[tuple[int, int]]:
        """(min_ts, max_ts) epoch-ms of stored ticks for a symbol, or None if none."""
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT min(ts) AS lo, max(ts) AS hi FROM ticks WHERE symbol=$1", symbol)
        if not row or row["hi"] is None:
            return None
        return int(row["lo"]), int(row["hi"])

    async def recent_ticks(self, symbol: str, since_ms: int, limit: int = 1_500_000) -> list[dict]:
        """The MOST-RECENT ticks at/after `since_ms`, returned ascending by ts. Uses the
        (symbol, ts) index + a DESC LIMIT so a busy window keeps its latest ticks (not the
        earliest), then reverses to chronological order for bucketing."""
        if not self.enabled:
            return []
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "SELECT symbol, ts, price, volume, bid, ask, side FROM ticks "
                "WHERE symbol=$1 AND ts>=$2 ORDER BY ts DESC LIMIT $3",
                symbol, since_ms, limit)
        return [dict(r) for r in reversed(rows)]

    async def recent_alerts(self, limit: int = 100) -> list[dict]:
        if not self.enabled:
            return []
        async with self.pool.acquire() as con:
            rows = await con.fetch("SELECT * FROM alerts ORDER BY ts DESC LIMIT $1", limit)
        return [dict(r) for r in rows]

    # ------------------------------------------- research / outcome validation
    async def get_unvalidated_signals(self, table_name: str) -> list[dict]:
        """Signal rows still awaiting MAE/MFE (mae IS NULL) from lp_/ad_signals."""
        if not self.enabled:
            return []
        if table_name not in _SIGNAL_TABLES:
            raise ValueError(f"unsupported signal table {table_name!r}")
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                f"SELECT * FROM {table_name} WHERE mae IS NULL ORDER BY start_time")
        return [dict(r) for r in rows]

    async def get_forward_closes(self, symbol: str, timeframe: str, start_time: int, limit: int) -> list[float]:
        """Closes of the candles immediately following start_time, oldest first."""
        if not self.enabled:
            return []
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "SELECT close FROM footprints WHERE symbol=$1 AND timeframe=$2 "
                "AND start_time > $3 ORDER BY start_time ASC LIMIT $4",
                symbol, timeframe, start_time, limit)
        return [float(r["close"]) for r in rows]

    async def _entry_close(self, symbol: str, timeframe: str, start_time: int) -> Optional[float]:
        """Close of the signal candle itself (the MAE/MFE entry reference)."""
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            r = await con.fetchrow(
                "SELECT close FROM footprints WHERE symbol=$1 AND timeframe=$2 AND start_time=$3 LIMIT 1",
                symbol, timeframe, start_time)
        return float(r["close"]) if r else None

    async def update_signal_outcome(self, table_name: str, signal_id: int,
                                    mae: float, mfe: float, outcome: str) -> None:
        if not self.enabled:
            return
        if table_name not in _SIGNAL_TABLES:
            raise ValueError(f"unsupported signal table {table_name!r}")
        async with self.pool.acquire() as con:
            await con.execute(
                f"UPDATE {table_name} SET mae=$1, mfe=$2, outcome=$3 WHERE id=$4",
                mae, mfe, outcome, signal_id)

    async def sync_signal_outcomes(self, horizon: int = 5) -> int:
        """Compute MAE/MFE/outcome for every still-unvalidated LP & AD signal that
        now has at least one forward candle, and persist the metrics. Returns the
        number of rows updated. Idempotent: validated rows (mae NOT NULL) are skipped,
        and signals without forward data yet are left for a later run."""
        if not self.enabled:
            return 0
        updated = 0
        for table, kind in (("lp_signals", "LP"), ("ad_signals", "AD")):
            for row in await self.get_unvalidated_signals(table):
                side = _signal_side_from_row(kind, row)
                if side is None:
                    continue
                forward = await self.get_forward_closes(
                    row["symbol"], row["timeframe"], row["start_time"], horizon)
                if not forward:
                    continue
                entry = await self._entry_close(row["symbol"], row["timeframe"], row["start_time"])
                if entry is None:
                    entry = row.get("price")   # LP level fallback if the candle is gone
                if entry is None:
                    continue
                outcome = evaluate_signal(float(entry), side, forward)
                if outcome is None:
                    continue
                status = "win" if outcome.ret > 0 else "loss" if outcome.ret < 0 else "flat"
                await self.update_signal_outcome(table, row["id"], outcome.mae, outcome.mfe, status)
                updated += 1
        return updated

    @staticmethod
    def _row_to_candle_dict(r) -> dict:
        return {
            "symbol": r["symbol"], "timeframe": r["timeframe"],
            "startTime": r["start_time"], "endTime": r["end_time"], "rowSize": r["row_size"],
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "totalVolume": r["total_volume"], "totalBidVolume": r["bid_volume"],
            "totalAskVolume": r["ask_volume"], "delta": r["delta"], "cumDelta": r["cum_delta"],
            "poc": r["poc"], "marketStructure": r["market_structure"],
            "cells": json.loads(r["cells"]), "signals": json.loads(r["signals"]),
            "closed": True,
        }

    # ------------------------------------------------------------- workspaces
    # Workspace/layout presets (Phase 3B). The API layer validates the payload (size + forbidden
    # live-data keys) BEFORE these run; this layer only persists JSON and never executes anything.
    _WS_COLS = ("id,name,description,profile,version,preset_json,is_default,is_archived,created_at,updated_at")

    @staticmethod
    def _row_to_workspace(r) -> dict:
        return {
            "id": r["id"], "name": r["name"], "description": r["description"],
            "profile": r["profile"], "version": r["version"],
            "isDefault": r["is_default"], "isArchived": r["is_archived"],
            "createdAt": r["created_at"], "updatedAt": r["updated_at"],
            "preset": json.loads(r["preset_json"]),
        }

    async def list_workspace_presets(self, profile: Optional[str] = None,
                                     include_archived: bool = False) -> list[dict]:
        if not self.enabled:
            return []
        clauses: list[str] = []
        params: list = []
        if not include_archived:
            clauses.append("is_archived = FALSE")
        if profile:
            params.append(profile)
            clauses.append(f"profile = ${len(params)}")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                f"SELECT {self._WS_COLS} FROM workspace_presets{where} ORDER BY updated_at DESC", *params)
        return [self._row_to_workspace(r) for r in rows]

    async def get_workspace_preset(self, preset_id: str) -> Optional[dict]:
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            r = await con.fetchrow(
                f"SELECT {self._WS_COLS} FROM workspace_presets WHERE id=$1", preset_id)
        return self._row_to_workspace(r) if r else None

    async def workspace_exists(self, preset_id: str) -> bool:
        if not self.enabled:
            return False
        async with self.pool.acquire() as con:
            r = await con.fetchrow("SELECT 1 FROM workspace_presets WHERE id=$1", preset_id)
        return r is not None

    async def create_workspace_preset(self, preset: dict) -> Optional[dict]:
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            r = await con.fetchrow(
                f"INSERT INTO workspace_presets(id,name,description,profile,version,preset_json,"
                f"is_default,is_archived,created_at,updated_at) "
                f"VALUES($1,$2,$3,$4,$5,$6::jsonb,FALSE,FALSE,$7,$8) RETURNING {self._WS_COLS}",
                preset["id"], preset["name"], preset.get("description"),
                preset.get("profile") or "Default", int(preset.get("version") or 1),
                json.dumps(preset), int(preset.get("createdAt") or 0), int(preset.get("updatedAt") or 0))
        return self._row_to_workspace(r) if r else None

    async def update_workspace_preset(self, preset_id: str, preset: dict) -> Optional[dict]:
        if not self.enabled:
            return None
        async with self.pool.acquire() as con:
            r = await con.fetchrow(
                f"UPDATE workspace_presets SET name=$2,description=$3,profile=$4,version=$5,"
                f"preset_json=$6::jsonb,updated_at=$7,is_archived=FALSE WHERE id=$1 RETURNING {self._WS_COLS}",
                preset_id, preset["name"], preset.get("description"),
                preset.get("profile") or "Default", int(preset.get("version") or 1),
                json.dumps(preset), int(preset.get("updatedAt") or 0))
        return self._row_to_workspace(r) if r else None

    async def archive_workspace_preset(self, preset_id: str) -> bool:
        """Soft delete only — never hard-deletes. Returns True if a live row was archived."""
        if not self.enabled:
            return False
        async with self.pool.acquire() as con:
            r = await con.fetchrow(
                "UPDATE workspace_presets SET is_archived=TRUE,is_default=FALSE "
                "WHERE id=$1 AND is_archived=FALSE RETURNING id", preset_id)
        return r is not None

    async def set_default_workspace_preset(self, preset_id: str) -> bool:
        """Mark one preset default and unset every other (global default — this backend has no users).
        Returns True if the target exists and is not archived."""
        if not self.enabled:
            return False
        async with self.pool.acquire() as con, con.transaction():
            exists = await con.fetchrow(
                "SELECT 1 FROM workspace_presets WHERE id=$1 AND is_archived=FALSE", preset_id)
            if exists is None:
                return False
            await con.execute("UPDATE workspace_presets SET is_default=(id=$1)", preset_id)
        return True
