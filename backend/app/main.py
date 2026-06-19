"""FastAPI application entrypoint.

Lifespan starts the live pipeline (TrueData/sim ingest + order-flow engine) and a
replay engine, then exposes REST routes (api/routes.py) and a WebSocket stream.
"""
from __future__ import annotations

import logging

# --- CRITICAL: force Databento's background event loop to be standard asyncio ---
# databento.live.client.Live builds a process-wide SINGLETON background event loop
# at IMPORT time (Live._loop = asyncio.new_event_loop()), using whatever asyncio
# policy is active at that moment. uvicorn installs the uvloop policy BEFORE it
# imports this module, so without intervention Live._loop becomes a uvloop loop — on
# which databento's data-receive path silently delivers ZERO records: the session
# authenticates and reports "N live", but no ticks ever arrive (blank charts).
# Importing databento here under the DEFAULT asyncio policy makes Live._loop a
# standard asyncio loop (which DOES deliver records), then we restore uvloop so the
# main FastAPI server loop keeps uvloop. (Verified empirically: uvloop Live._loop ->
# 0 ticks; asyncio Live._loop -> ticks flow.)
import asyncio

_db_loop_policy = asyncio.get_event_loop_policy()
try:
    asyncio.set_event_loop_policy(asyncio.DefaultEventLoopPolicy())
    import databento  # noqa: F401 — creates Live._loop as a standard asyncio loop
    logging.getLogger("main").info("Pre-imported databento under default asyncio policy (Live._loop = asyncio).")
except Exception as _exc:  # never block boot if databento isn't importable (dev / py3.14)
    logging.getLogger("main").warning("databento pre-import skipped: %s", _exc)
finally:
    asyncio.set_event_loop_policy(_db_loop_policy)

# Monkeypatch Databento for uvloop compatibility (connection handshake under uvloop)
try:
    import asyncio
    import databento.live.protocol as db_protocol
    
    def patched_connection_made(self, transport):
        # Bypass the strict isinstance(transport, asyncio.WriteTransport) check
        # which fails under uvloop since uvloop transports don't inherit directly.
        self._DatabentoLiveProtocol__transport = transport
        return asyncio.BufferedProtocol.connection_made(self, transport)
        
    db_protocol.DatabentoLiveProtocol.connection_made = patched_connection_made
    logging.getLogger("main").info("Monkeypatched DatabentoLiveProtocol for uvloop compatibility.")
except Exception as exc:
    logging.getLogger("main").warning("Failed to monkeypatch Databento protocol: %s", exc)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router
from .config import settings
from .pipeline import Pipeline
from .replay.replay_engine import ReplayEngine

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("main")

app = FastAPI(title="Vikings Order Flow Terminal", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


@app.on_event("startup")
async def _startup() -> None:
    pipeline = Pipeline(settings)
    await pipeline.start()
    app.state.pipeline = pipeline
    app.state.replay = ReplayEngine(pipeline.pg, pipeline.connections, settings, pipeline.client)
    log.info("Startup complete.")


@app.on_event("shutdown")
async def _shutdown() -> None:
    if getattr(app.state, "pipeline", None):
        await app.state.pipeline.stop()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    pipeline: Pipeline = app.state.pipeline
    mgr = pipeline.connections
    cid = await mgr.connect(ws)
    try:
        # initial handshake: current status + default snapshot
        await mgr.send_to(cid, {"type": "status", "data": pipeline.status()})
        default_symbol = settings.symbols[0] if settings.symbols else None
        if default_symbol:
            # default chart mode is candle -> cells-free handshake snapshot (small/fast);
            # the client re-subscribes with its actual mode immediately after.
            snap = await pipeline.snapshot(
                default_symbol, settings.default_timeframe, settings.websocket_snapshot_limit, cells=False)
            await mgr.send_to(cid, {"type": "snapshot", "data": {
                "symbol": default_symbol, "timeframe": settings.default_timeframe, "candles": snap,
            }})

        while True:
            msg = await ws.receive_json()
            action = msg.get("action")
            if action == "subscribe":
                symbol = (msg.get("symbol") or "").upper() or None
                timeframe = msg.get("timeframe") or None
                replay = bool(msg.get("replay", False))
                raw_rs = msg.get("rowSize")
                row_size = float(raw_rs) if raw_rs else None
                raw_limit = msg.get("limit")
                limit = (
                    settings.websocket_snapshot_limit
                    if raw_limit is None
                    else max(1, min(int(raw_limit), settings.max_snapshot_limit))
                )
                want_cells = bool(msg.get("cells", True))  # candle mode sends cells:false
                mgr.set_filter(cid, symbol, timeframe, replay, row_size)
                if symbol and timeframe and not replay:
                    # spin up an aggregator for this (symbol, timeframe, consolidation)
                    # so live candles flow, then send the (consolidated) snapshot.
                    pipeline.aggregator.ensure(symbol, timeframe, row_size)
                    snap = await pipeline.snapshot(symbol, timeframe, limit, row_size, cells=want_cells)
                    await mgr.send_to(cid, {"type": "snapshot", "data": {
                        "symbol": symbol, "timeframe": timeframe, "candles": snap,
                    }})
            elif action == "ping":
                await mgr.send_to(cid, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover
        log.exception("ws error")
    finally:
        await mgr.disconnect(cid)


@app.get("/")
async def root() -> dict:
    return {"service": "Vikings Order Flow Terminal", "docs": "/docs", "ws": "/ws"}
