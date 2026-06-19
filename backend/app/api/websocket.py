"""Frontend WebSocket fan-out.

Message envelope (all server->client):
    {"type": "candle"|"alert"|"status"|"snapshot", "data": ...}

Clients may send {"action": "subscribe", "symbol": "...", "timeframe": "..."} to
filter the candle stream; by default they receive everything.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket

log = logging.getLogger("api.ws")


@dataclass
class _Client:
    ws: WebSocket
    symbol: str | None = None
    timeframe: str | None = None
    replay: bool = False   # True => this client wants the replay feed, not live
    row_size: float | None = None   # consolidation level (None => any)


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: dict[int, _Client] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> int:
        await ws.accept()
        cid = id(ws)
        async with self._lock:
            self._clients[cid] = _Client(ws=ws)
        return cid

    async def disconnect(self, cid: int) -> None:
        async with self._lock:
            self._clients.pop(cid, None)

    def set_filter(self, cid: int, symbol: str | None, timeframe: str | None,
                   replay: bool = False, row_size: float | None = None) -> None:
        c = self._clients.get(cid)
        if c:
            c.symbol = symbol
            c.timeframe = timeframe
            c.replay = replay
            c.row_size = row_size

    @property
    def count(self) -> int:
        return len(self._clients)

    async def send_to(self, cid: int, message: dict) -> None:
        c = self._clients.get(cid)
        if not c:
            return
        try:
            await c.ws.send_text(json.dumps(message))
        except Exception:
            await self.disconnect(cid)

    async def _send_safe(self, cid: int, ws: WebSocket, payload: str) -> None:
        try:
            await ws.send_text(payload)
        except Exception:
            await self.disconnect(cid)

    async def broadcast(
        self,
        message: dict,
        symbol: str | None = None,
        timeframe: str | None = None,
        replay: bool = False,
        row_size: float | None = None,
    ) -> None:
        """Send to clients on the matching feed (live vs replay), honoring the
        per-client symbol / timeframe / row-size (consolidation) filters. A live
        broadcast never reaches a replay client, and a candle at one consolidation
        level never reaches a client viewing a different one."""
        payload = json.dumps(message)
        tasks = []
        for cid, c in list(self._clients.items()):
            if c.replay != replay:
                continue
            if symbol and c.symbol and c.symbol != symbol:
                continue
            if timeframe and c.timeframe and c.timeframe != timeframe:
                continue
            if row_size is not None and c.row_size is not None and c.row_size != row_size:
                continue
            tasks.append(self._send_safe(cid, c.ws, payload))
        if tasks:
            await asyncio.gather(*tasks)
