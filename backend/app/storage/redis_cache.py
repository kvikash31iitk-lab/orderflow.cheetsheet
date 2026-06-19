"""Redis hot cache + pub/sub.

Caches the most recent footprint candles per (symbol, timeframe) so a freshly
connected frontend gets an instant snapshot, and stores the live connection
status. Degrades to no-op when Redis is unreachable.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

import redis.asyncio as aioredis

from ..config import Settings, settings as default_settings

log = logging.getLogger("storage.redis")
_MAX_CACHED = 300


class RedisCache:
    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self.client: Optional[aioredis.Redis] = None
        self.enabled = False

    async def connect(self) -> None:
        try:
            self.client = aioredis.from_url(self.cfg.redis_url, decode_responses=True)
            await self.client.ping()
            self.enabled = True
            log.info("Redis connected (%s)", self.cfg.redis_host)
        except Exception as exc:
            log.warning("Redis unavailable (%s) — caching disabled.", exc)
            self.enabled = False

    async def close(self) -> None:
        if self.client is not None:
            await self.client.aclose()

    @staticmethod
    def _key(symbol: str, timeframe: str) -> str:
        return f"fp:{symbol}:{timeframe}"

    async def push_candle(self, symbol: str, timeframe: str, candle: dict) -> None:
        """Replace the open candle / append a closed one in a capped list."""
        if not self.enabled:
            return
        key = self._key(symbol, timeframe)
        payload = json.dumps(candle)
        try:
            if candle.get("closed"):
                await self.client.rpush(key, payload)
                await self.client.ltrim(key, -_MAX_CACHED, -1)
            # always cache the latest (open or closed) snapshot
            await self.client.set(f"{key}:live", payload)
        except Exception as exc:  # pragma: no cover
            log.debug("redis push_candle failed: %s", exc)

    async def get_candles(self, symbol: str, timeframe: str, limit: int = _MAX_CACHED) -> list[dict]:
        if not self.enabled:
            return []
        try:
            items = await self.client.lrange(self._key(symbol, timeframe), -limit, -1)
            return [json.loads(i) for i in items]
        except Exception:  # pragma: no cover
            return []

    async def set_status(self, status: dict) -> None:
        if not self.enabled:
            return
        try:
            await self.client.set("md:status", json.dumps(status))
        except Exception:  # pragma: no cover
            pass

    async def get_status(self) -> Optional[dict]:
        if not self.enabled:
            return None
        raw = await self.client.get("md:status")
        return json.loads(raw) if raw else None
