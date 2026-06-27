"""REST API: snapshots, scanner, alerts, replay control, research, metadata."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from ..config import TIMEFRAME_MINUTES, Settings, is_seconds_timeframe, settings
from ..orderflow import research
from ..orderflow.models import FootprintCandle
from ..market_data.aggregator import default_row_size, get_symbol_config, SYMBOL_CONFIG

router = APIRouter(prefix="/api")


def _check_param_keys(keys) -> None:
    """Reject override keys that aren't real Settings fields (surfaces typos as 422
    instead of silently producing misleading backtest numbers)."""
    unknown = [k for k in keys if k not in Settings.model_fields]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown research parameters: {unknown}")


def _pipeline(req: Request):
    return req.app.state.pipeline


def _replay(req: Request):
    return req.app.state.replay


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}


@router.get("/status")
async def status(req: Request) -> dict:
    return _pipeline(req).status()


@router.get("/symbols")
async def symbols() -> dict:
    return {"symbols": settings.symbols}


@router.get("/timeframes")
async def timeframes() -> dict:
    return {"timeframes": list(TIMEFRAME_MINUTES.keys()), "default": settings.default_timeframe}


@router.get("/symbol-config")
async def symbol_config() -> dict:
    """Per-symbol order-flow tuning table (row size, imbalance thresholds, etc.).

    The frontend fetches this once and applies each symbol's imbalance ratio /
    highlight volume to the footprint renderer."""
    return SYMBOL_CONFIG


@router.get("/symbol-config/{symbol}")
async def symbol_config_one(symbol: str) -> dict:
    """Order-flow tuning for one symbol (falls back to engine defaults if unknown)."""
    return get_symbol_config(symbol)


@router.get("/footprints")
async def footprints(req: Request, symbol: str, timeframe: str | None = None,
                     limit: int | None = None, rowSize: float | None = None,
                     cells: bool = True) -> dict:
    tf = timeframe or settings.default_timeframe
    # Sub-minute (e.g. 5S) timeframes are reconstructed on demand from ticks via a
    # separate, tightly-clamped path (they are never stored as minute candles).
    if is_seconds_timeframe(tf):
        lim = settings.max_seconds_snapshot_limit if limit is None else limit
        lim = max(1, min(lim, settings.max_seconds_snapshot_limit))
        candles = await _pipeline(req).snapshot_seconds(symbol.upper(), tf, lim, rowSize, cells=cells)
        return {"symbol": symbol.upper(), "timeframe": tf, "candles": candles}
    # default to the configured snapshot size; hard-clamp so no client can request an
    # unbounded payload (footprint candles are heavy).
    lim = settings.default_snapshot_limit if limit is None else limit
    lim = max(1, min(lim, settings.max_snapshot_limit))
    # cells=false -> candle-only payload (no per-price footprint cells) for fast candle-mode loads
    candles = await _pipeline(req).snapshot(symbol.upper(), tf, lim, rowSize, cells=cells)
    return {"symbol": symbol.upper(), "timeframe": tf, "candles": candles}


@router.get("/scanner")
async def scanner(req: Request) -> dict:
    return {"rows": _pipeline(req).scanner()}


@router.get("/alerts")
async def alerts(req: Request, limit: int = 100) -> dict:
    return {"alerts": _pipeline(req).recent_alerts()[:limit]}


class TimeframeBody(BaseModel):
    timeframe: str


@router.post("/timeframe/add")
async def add_timeframe(req: Request, body: TimeframeBody) -> dict:
    if body.timeframe not in TIMEFRAME_MINUTES:
        return {"ok": False, "error": "unknown timeframe"}
    _pipeline(req).aggregator.add_timeframe(body.timeframe)
    return {"ok": True, "timeframes": _pipeline(req).aggregator.timeframes}


# ----------------------------- replay -----------------------------
class ReplayLoad(BaseModel):
    symbol: str
    start: int           # epoch ms
    end: int             # epoch ms
    timeframe: str | None = None


class ReplayPlay(BaseModel):
    speed: int = 1


@router.post("/replay/load")
async def replay_load(req: Request, body: ReplayLoad) -> dict:
    tf = body.timeframe or settings.default_timeframe
    n = await _replay(req).load(body.symbol, body.start, body.end, tf)
    return {"ok": True, "ticks": n, "symbol": body.symbol.upper(), "timeframe": tf}


@router.post("/replay/play")
async def replay_play(req: Request, body: ReplayPlay) -> dict:
    await _replay(req).play(body.speed)
    return {"ok": True, "playing": True, "speed": _replay(req).speed}


@router.post("/replay/pause")
async def replay_pause(req: Request) -> dict:
    await _replay(req).pause()
    return {"ok": True, "playing": False}


@router.post("/replay/step")
async def replay_step(req: Request) -> dict:
    advanced = await _replay(req).step()
    return {"ok": True, "advanced": advanced}


@router.post("/replay/stop")
async def replay_stop(req: Request) -> dict:
    await _replay(req).stop()
    return {"ok": True}


# ----------------------------- research -----------------------------
async def _load_candles(req: Request, symbol: str, timeframe: str, limit: int) -> list[FootprintCandle]:
    base = default_row_size(symbol)
    rows = await _pipeline(req).pg.recent_footprints(symbol.upper(), timeframe, limit, row_size=base)
    return [FootprintCandle.from_dict(r) for r in rows]


class ResearchValidate(BaseModel):
    symbol: str
    timeframe: str | None = None
    kind: str = "AD"           # AD | LP | ABSORPTION | EXHAUSTION
    horizon: int = 5
    limit: int = 3000
    params: dict[str, float] = {}   # optional threshold overrides -> re-analyse first


class ResearchSweep(BaseModel):
    symbol: str
    timeframe: str | None = None
    kind: str = "AD"
    horizon: int = 5
    grid: dict[str, list] = {}     # Settings field name -> candidate values
    limit: int = 3000


@router.post("/research/validate")
async def research_validate(req: Request, body: ResearchValidate) -> dict:
    if body.params:
        _check_param_keys(body.params)   # fail fast before loading candles
    tf = body.timeframe or settings.default_timeframe
    candles = await _load_candles(req, body.symbol, tf, body.limit)
    # if threshold overrides are supplied, re-run the engine with them so the
    # backtest reflects the chosen settings (this is what "Apply" relies on)
    if body.params:
        candles = research.replay_with_settings(candles, body.params)
    report = research.validate(candles, body.kind.upper(), horizon=body.horizon)
    return report.to_dict()


@router.post("/research/sweep")
async def research_sweep(req: Request, body: ResearchSweep) -> dict:
    _check_param_keys(body.grid)
    tf = body.timeframe or settings.default_timeframe
    candles = await _load_candles(req, body.symbol, tf, body.limit)
    reports = research.sweep(candles, body.kind.upper(), body.grid, horizon=body.horizon)
    return {"reports": [r.to_dict() for r in reports]}


@router.post("/research/sync")
async def research_sync(req: Request, horizon: int = 5) -> dict:
    updated = await _pipeline(req).pg.sync_signal_outcomes(horizon)
    return {"updated": updated}


# ----------------------------- SC1 V4 research lab -----------------------------
# Deterministic, offline re-implementation of the SC1 super signal (Indicator 1).
# Does NOT touch the live SC1 V4 indicator; reads stored candles + ticks only.
from ..research.sc1 import service as sc1_service
from ..research.sc1 import large as sc1_large
from ..research.sc1.config import ExitConfig, Sc1Config
from ..research.sc1 import parquet_provider as sc1_parquet

# Research data SOURCE: "live_postgres" (the live footprints/ticks tables, default — unchanged
# behaviour) or "historical_parquet" (the read-only normalized GC.V.0 Parquet research dataset,
# NEVER the live footprints table). Both objects expose the same footprints_minmax /
# footprints_range / recent_ticks interface, so the SC1 job layer is untouched.
_SC1_SOURCES = ("live_postgres", "historical_parquet")


def _sc1_source(req: Request | None, source: str | None):
    if source in (None, "", "live_postgres"):
        return _pipeline(req).pg
    if source == "historical_parquet":
        return sc1_parquet.get_provider()
    raise HTTPException(status_code=422, detail=f"unknown research source {source!r}; use one of {_SC1_SOURCES}")


def _sc1_config(overrides: dict | None) -> Sc1Config:
    cfg = Sc1Config()
    if overrides:
        allowed = set(Sc1Config().to_dict().keys())
        unknown = [k for k in overrides if k not in allowed]
        if unknown:
            raise HTTPException(status_code=422, detail=f"unknown sc1 config keys: {unknown}")
        cfg = cfg.clone(**{k: v for k, v in overrides.items() if k in allowed})
    return cfg


def _exit_config(overrides: dict | None) -> ExitConfig:
    cfg = ExitConfig()
    if overrides:
        for k, v in overrides.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
    return cfg


class Sc1Run(BaseModel):
    symbol: str
    timeframe: str | None = None
    start: int | None = None        # epoch ms (inclusive)
    end: int | None = None          # epoch ms (inclusive)
    use5s: bool = True
    config: dict = {}               # Sc1Config field overrides


class Sc1CompareExits(BaseModel):
    runId: str
    classes: list[str] | None = None      # subset of baseline/blocked_by_candle/near_miss
    exit: dict = {}                       # ExitConfig field overrides


class Sc1Sweep(BaseModel):
    symbol: str
    timeframe: str | None = None
    start: int | None = None
    end: int | None = None
    use5s: bool = True
    config: dict = {}                     # base Sc1Config overrides
    grid: dict[str, list] = {}            # Sc1Config field -> candidate values
    exit: dict = {}
    exitModel: str = "fixed_2R"


@router.get("/research/sc1/coverage")
async def sc1_coverage(req: Request, symbol: str) -> dict:
    return await sc1_service.coverage(_pipeline(req).pg, symbol)


@router.post("/research/sc1/run")
async def sc1_run(req: Request, body: Sc1Run) -> dict:
    tf = body.timeframe or settings.default_timeframe
    cfg = _sc1_config(body.config)
    return await sc1_service.run(_pipeline(req).pg, body.symbol, tf, body.start, body.end, cfg, body.use5s)


@router.post("/research/sc1/compare-exits")
async def sc1_compare_exits(body: Sc1CompareExits) -> dict:
    # CPU-bound over ~thousands of trades -> off the event loop (keeps the live feed responsive)
    import asyncio
    return await asyncio.to_thread(sc1_service.compare_exits, body.runId, _exit_config(body.exit), body.classes)


@router.post("/research/sc1/sweep")
async def sc1_sweep(req: Request, body: Sc1Sweep) -> dict:
    tf = body.timeframe or settings.default_timeframe
    base = _sc1_config(body.config)
    return await sc1_service.sweep(_pipeline(req).pg, body.symbol, tf, body.start, body.end,
                                   base, body.grid, _exit_config(body.exit), body.exitModel, body.use5s)


# ---------------- SC1 large-dataset jobs (async, polled — for 5y-scale research) ----------------
class Sc1WalkForward(BaseModel):
    windows: int = 4
    trainFrac: float = 0.6
    valFrac: float = 0.2
    testFrac: float = 0.2


class Sc1Optimize(BaseModel):
    method: str = "coordinate"            # coordinate | grid | random
    params: list[str] | None = None       # subset of the bounded search space
    budget: int = 60
    seed: int = 1
    exitModel: str = "fixed_2R"
    minSample: int = 25


class Sc1JobCreate(BaseModel):
    mode: str                             # "large_run" | "walk_forward"
    symbol: str
    timeframe: str | None = None
    start: int | None = None
    end: int | None = None
    use5s: bool = False                   # history uses parent orderflow by default
    source: str = "live_postgres"         # "live_postgres" | "historical_parquet" (research-only)
    config: dict = {}
    exit: dict = {}
    walkForward: Sc1WalkForward = Sc1WalkForward()
    optimize: Sc1Optimize = Sc1Optimize()


@router.get("/research/sc1/historical/coverage")
async def sc1_historical_coverage(symbol: str = "GC.V.0") -> dict:
    """Coverage of the read-only historical Parquet dataset (timeframes, date span, counts).
    Independent of the live DB; returns available=False with a note if the data dir is absent."""
    return await sc1_parquet.get_provider().coverage(symbol)


@router.post("/research/sc1/jobs")
async def sc1_job_create(req: Request, body: Sc1JobCreate) -> dict:
    tf = body.timeframe or settings.default_timeframe
    cfg = _sc1_config(body.config)
    exit_cfg = _exit_config(body.exit)
    pg = _sc1_source(req, body.source)    # live footprints OR read-only historical Parquet
    if body.source == "historical_parquet":   # shared-box guardrail: bound the scanned span
        try:
            sc1_parquet.check_span_days(body.start, body.end)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
    echo = {"mode": body.mode, "symbol": body.symbol.upper(), "timeframe": tf, "source": body.source,
            "start": body.start, "end": body.end, "use5s": body.use5s, "config": cfg.to_dict()}
    if body.mode == "walk_forward":
        if body.optimize.method not in ("coordinate", "grid", "random"):
            raise HTTPException(status_code=422, detail=f"unknown optimizer method: {body.optimize.method}")
        echo["walkForward"] = body.walkForward.model_dump()
        echo["optimize"] = body.optimize.model_dump()
        return await sc1_large.start_walkforward_job(
            pg, body.symbol, tf, body.start, body.end, cfg, exit_cfg, body.use5s,
            body.walkForward.model_dump(), body.optimize.model_dump(), echo)
    if body.mode == "large_run":
        return await sc1_large.start_large_job(
            pg, body.symbol, tf, body.start, body.end, cfg, exit_cfg, body.use5s, echo)
    raise HTTPException(status_code=422, detail=f"unknown job mode: {body.mode}")


@router.get("/research/sc1/jobs")
async def sc1_job_list() -> dict:
    return sc1_large.job_list()


@router.get("/research/sc1/jobs/{job_id}")
async def sc1_job_get(job_id: str) -> dict:
    return sc1_large.job_status(job_id)


@router.post("/research/sc1/jobs/{job_id}/cancel")
async def sc1_job_cancel(job_id: str) -> dict:
    return sc1_large.job_cancel(job_id)


@router.get("/research/sc1/jobs/{job_id}/candidates")
async def sc1_job_candidates(job_id: str, page: int = 0, size: int = 100,
                             klass: str | None = None, side: str | None = None) -> dict:
    return sc1_large.job_candidates(job_id, page, size, klass, side)


@router.get("/research/sc1/jobs/{job_id}/trades")
async def sc1_job_trades(job_id: str, page: int = 0, size: int = 100, exitModel: str | None = None,
                         klass: str | None = None, side: str | None = None, result: str | None = None) -> dict:
    return sc1_large.job_trades(job_id, page, size, exitModel, klass, side, result)


@router.get("/research/sc1/jobs/{job_id}/matrix")
async def sc1_job_matrix(job_id: str) -> dict:
    return sc1_large.job_matrix(job_id)


# ----------------------------- simulated trading -----------------------------
async def _broadcast_trade(pl) -> None:
    for ev in pl.broker.drain():
        sym = ev.get("symbol")
        await pl.connections.broadcast(ev, symbol=sym)


class TradeOrder(BaseModel):
    symbol: str
    side: str                       # buy | sell
    type: str = "market"            # market | limit
    qty: float
    price: float | None = None      # required for limit


class TradeCancel(BaseModel):
    order_id: int


class TradeFlatten(BaseModel):
    symbol: str


@router.post("/trade/order")
async def trade_order(req: Request, body: TradeOrder) -> dict:
    pl = _pipeline(req)
    order = pl.broker.place_order(body.symbol.upper(), body.side, body.type, body.qty, body.price)
    await _broadcast_trade(pl)
    return order.to_dict()


@router.post("/trade/cancel")
async def trade_cancel(req: Request, body: TradeCancel) -> dict:
    pl = _pipeline(req)
    ok = pl.broker.cancel_order(body.order_id)
    await _broadcast_trade(pl)
    return {"ok": ok}


@router.post("/trade/flatten")
async def trade_flatten(req: Request, body: TradeFlatten) -> dict:
    pl = _pipeline(req)
    pl.broker.flatten(body.symbol.upper())
    await _broadcast_trade(pl)
    return {"ok": True}


@router.get("/trade/state")
async def trade_state(req: Request) -> dict:
    return _pipeline(req).broker.state()


# ----------------------------------------------------------------- workspaces
# Backend-synced workspace/layout presets (Phase 3B). This backend has NO auth, so presets are GLOBAL
# (shared by all clients); `profile` is a soft scope label. The frontend keeps localStorage as the
# offline source of truth — if PG is down these endpoints 503 and the UI falls back to local-only.
# We persist JSON only and NEVER execute indicator source from a preset.
WORKSPACE_SCHEMA_VERSION = 1
WORKSPACE_MAX_BYTES = 2_000_000  # ~2 MB cap (mirrors the frontend guard)

# Object KEYS that must never appear anywhere in a synced workspace payload — live market / account /
# connection / secret data. We scan KEYS only (an indicator script may legitimately *mention* these
# words in its text; that's a value, not a key, and is never executed here).
_WORKSPACE_FORBIDDEN_KEYS = frozenset({
    "candles", "candle", "ticks", "tick", "scanner", "alerts", "positions", "orders", "fills",
    "pnl", "feedstatus", "feed_status", "connection", "connectionstate", "connection_state",
    "apikey", "api_key", "token", "accesstoken", "access_token", "refreshtoken", "refresh_token",
    "secret", "secrets", "password", "credential", "credentials", "bearer", "authorization",
})


def _scan_forbidden_keys(obj, parent: str | None = None, depth: int = 0) -> str | None:
    """Recursively return the first forbidden object key found (case-insensitive), else None.
    Bounded depth guards against a pathologically nested payload.

    One deliberate exception: `panes.scanner` is a legitimate boolean UI flag (show/hide the SCANNER
    PANE), not scanner data, so it is allowed only directly under a `panes` object. Every other use of
    a forbidden word as a key — at any depth — is rejected."""
    if depth > 40:
        raise HTTPException(status_code=422, detail="workspace payload nested too deep")
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and k.lower() in _WORKSPACE_FORBIDDEN_KEYS:
                # the ONLY allowed forbidden-word key is panes.scanner, and only as a boolean UI flag —
                # never an object/array (which could smuggle scanner data past the key scan).
                allowed = k.lower() == "scanner" and (parent or "").lower() == "panes" and isinstance(v, bool)
                if not allowed:
                    return k
            found = _scan_forbidden_keys(v, k if isinstance(k, str) else parent, depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _scan_forbidden_keys(v, parent, depth + 1)
            if found:
                return found
    return None


def _validate_workspace_preset(preset: dict) -> None:
    """Reject anything that isn't a safe WorkspacePresetV1: wrong version, missing required fields,
    oversized, or carrying any live/market/account/secret key. Raises HTTPException."""
    if not isinstance(preset, dict):
        raise HTTPException(status_code=422, detail="workspace preset must be an object")
    if preset.get("version") != WORKSPACE_SCHEMA_VERSION:
        raise HTTPException(status_code=422,
                            detail=f"unsupported workspace version {preset.get('version')!r} (expected {WORKSPACE_SCHEMA_VERSION})")
    if not isinstance(preset.get("id"), str) or not preset["id"]:
        raise HTTPException(status_code=422, detail="workspace preset id is required")
    if not isinstance(preset.get("name"), str) or not preset["name"].strip():
        raise HTTPException(status_code=422, detail="workspace preset name is required")
    if not isinstance(preset.get("snapshot"), dict):
        raise HTTPException(status_code=422, detail="workspace preset snapshot is required")
    try:
        size = len(json.dumps(preset).encode("utf-8"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="workspace preset is not serializable")
    if size > WORKSPACE_MAX_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"workspace preset too large ({size} bytes > {WORKSPACE_MAX_BYTES})")
    bad = _scan_forbidden_keys(preset)
    if bad:
        raise HTTPException(status_code=422, detail=f"workspace preset contains a forbidden field: {bad!r}")


class WorkspacePresetBody(BaseModel):
    # extra="forbid" rejects unknown TOP-LEVEL fields (snapshot is a free dict, scanned separately).
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    version: int
    createdAt: int
    updatedAt: int
    snapshot: dict
    description: str | None = None
    profile: str = "Default"
    builtin: bool = False


def _ws_pg(req: Request):
    """The workspace store, or a 503 if PG isn't connected (the frontend then stays local-only)."""
    pg = _pipeline(req).pg
    if not getattr(pg, "enabled", False):
        raise HTTPException(status_code=503, detail="workspace sync unavailable (no database)")
    return pg


@router.get("/workspaces")
async def list_workspaces(req: Request, profile: str | None = None) -> dict:
    # Routed through _ws_pg so a disconnected DB returns 503 — the client treats that as "offline" and
    # keeps its local presets. (Returning an ambiguous empty list here would look like "no presets" and
    # make the client wrongly demote every synced preset to local-only.)
    pg = _ws_pg(req)
    rows = await pg.list_workspace_presets(profile=profile, include_archived=False)
    return {"presets": rows}


@router.get("/workspaces/{preset_id}")
async def get_workspace(req: Request, preset_id: str) -> dict:
    row = await _pipeline(req).pg.get_workspace_preset(preset_id)
    if not row or row.get("isArchived"):
        raise HTTPException(status_code=404, detail="workspace preset not found")
    return row


@router.post("/workspaces")
async def create_workspace(req: Request, body: WorkspacePresetBody) -> dict:
    preset = body.model_dump()
    _validate_workspace_preset(preset)
    pg = _ws_pg(req)
    if await pg.workspace_exists(preset["id"]):
        raise HTTPException(status_code=409, detail="workspace preset already exists; use PUT to update")
    row = await pg.create_workspace_preset(preset)
    if row is None:
        raise HTTPException(status_code=503, detail="workspace sync unavailable")
    return row


@router.put("/workspaces/{preset_id}")
async def update_workspace(req: Request, preset_id: str, body: WorkspacePresetBody) -> dict:
    preset = body.model_dump()
    preset["id"] = preset_id  # path id wins; keep the stored JSON's id consistent with the row
    _validate_workspace_preset(preset)
    pg = _ws_pg(req)
    row = await pg.update_workspace_preset(preset_id, preset)
    if row is None:
        raise HTTPException(status_code=404, detail="workspace preset not found")
    return row


@router.delete("/workspaces/{preset_id}")
async def delete_workspace(req: Request, preset_id: str) -> dict:
    pg = _ws_pg(req)
    ok = await pg.archive_workspace_preset(preset_id)  # soft delete only
    if not ok:
        raise HTTPException(status_code=404, detail="workspace preset not found")
    return {"ok": True, "archived": preset_id}


@router.post("/workspaces/{preset_id}/default")
async def default_workspace(req: Request, preset_id: str) -> dict:
    pg = _ws_pg(req)
    ok = await pg.set_default_workspace_preset(preset_id)
    if not ok:
        raise HTTPException(status_code=404, detail="workspace preset not found")
    return {"ok": True, "default": preset_id}
