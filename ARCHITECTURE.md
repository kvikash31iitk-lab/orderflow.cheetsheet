# Architecture

## Goals

1. **Never block the ingest path.** TrueData can burst >100k ticks/min. The hot
   path (`Pipeline._on_tick`) only mutates in-memory structures; all I/O
   (Postgres, Redis, WebSocket, webhooks, parquet) is drained by background tasks.
2. **One source of truth for the wire format.** `FootprintCandle.to_dict()`
   (backend) ⇄ `types/orderflow.ts` (frontend). camelCase on the wire.
3. **Custom WebGL footprint rendering.** Generic chart libs choke on footprint
   cells; the renderer is a hand-written PixiJS scene with a text pool.

## End-to-end data flow

```
TrueData SDK (thread)            asyncio event loop
──────────────────────          ─────────────────────────────────────────────
trade_callback(tick)
   └─ queue.Queue ───────────▶  _drain_queue()  ──▶ on_tick(raw)
                                                       │
                                  TickHandler.normalise (classify aggressor side)
                                                       │
                          ┌────────────────────────────┼───────────────────────┐
                          ▼                            ▼                         ▼
                  TickRecorder.add            tick DB buffer            AggregatorManager.process
                  (parquet, buffered)         (batched 1 s)             (per timeframe)
                                                                              │
                                                          Aggregator.add_tick → footprint.add_tick
                                                                              │
                                                          OrderFlowEngine.analyze(commit=?)
                                                                              │
                                       live candle (dirty set)        closed candle
                                                │                            │
                                  _broadcast_loop (8 Hz)        save_candle (PG) + push (Redis)
                                                │                + AlertEngine.evaluate
                                                ▼                + scanner update
                                       ConnectionManager.broadcast ──▶ browsers
```

## Modules

### `market_data/`
- **`websocket_client.py`** — `MarketDataClient`. Wraps the `truedata_ws` SDK
  (sync, runs its callback on its own thread) and bridges to asyncio via a
  thread-safe `queue.Queue` drained by `_drain_queue`. Provides:
  auto-reconnect (SDK-native) + a `_heartbeat` staleness monitor, a
  `ConnectionStatus` feed, `get_history()`, and a deterministic **simulator**
  fallback (`_sim_symbol`) when TrueData is unavailable.
- **`tick_handler.py`** — aggressor classification (`price ≥ ask → BUY`,
  `price ≤ bid → SELL`, tick-rule fallback) + tick normalisation.
- **`aggregator.py`** — `Aggregator` buckets ticks into `FootprintCandle`s by
  time (or tick count for the `tick` timeframe) and owns an `OrderFlowEngine`.
  `AggregatorManager` fans one tick out to every active timeframe.

### `orderflow/`
- **`models.py`** — `Tick`, `FootprintCell`, `FootprintCandle`, `Signals`,
  `ImbalanceZone`. Plain `@dataclass(slots=True)` for speed; each has `to_dict()`.
- **`footprint.py`** — fold a classified tick into a candle (OHLC + bid/ask cell
  volume, price→row bucketing).
- **`delta.py / imbalance.py / absorption.py / exhaustion.py /
  lp_detection.py / ad_detection.py / market_structure.py`** — one detector each,
  pure functions, independently unit-tested.
- **`engine.py`** — `OrderFlowEngine` holds rolling cross-candle state
  (cum-delta, volume/delta deques, swing pivots) and orchestrates detectors.
  `analyze(candle, commit, light)`: **light** path (live candle) = delta,
  cum-delta, imbalance, volume nodes; **full** path (on close) adds the
  numpy/percentile detectors. This split is the key throughput optimisation.

### `storage/`
- **`postgres.py`** — async `asyncpg` repo. Degrades to no-op if the DB is down.
  Batches tick inserts; upserts footprints + signal tables.
- **`redis_cache.py`** — hot cache of recent candles per (symbol, timeframe) for
  instant frontend snapshots, plus live status.
- **`recorder.py`** — every tick appended to per-day parquet (jsonl fallback).
- **`schema.sql`** — `ticks, footprints, delta, cum_delta, absorption,
  exhaustion, lp_signals, ad_signals, imbalances, alerts` (indexed).

### `alerts/`
- **`alert_engine.py`** — turns closed-candle signals into deduplicated alerts.
- **`notifiers.py`** — Telegram / Discord / WhatsApp webhooks (popup + sound are
  client-side via the WS broadcast).

### `replay/`
- **`replay_engine.py`** — loads recorded ticks from Postgres and replays them
  through an **isolated** AggregatorManager at 1×–50× or candle-by-candle,
  broadcasting `{type:"candle", replay:true}` + `{type:"replay"}` progress.

### `api/` + `pipeline.py` + `main.py`
- **`websocket.py`** — `ConnectionManager` fan-out with per-client symbol/tf filter.
- **`routes.py`** — REST surface.
- **`pipeline.py`** — wires all components; owns the hot path + background loops.
- **`main.py`** — FastAPI app, lifespan start/stop, `/ws` endpoint.

## Threading / concurrency model

- TrueData SDK callback runs on a **separate thread** → bounded `queue.Queue` →
  single asyncio consumer. No locks on the hot path.
- Three background asyncio tasks: `_broadcast_loop` (8 Hz), `_db_flush_loop`
  (1 s batches), `_status_loop` (1 s).
- One `OrderFlowEngine` per (symbol, timeframe); no shared mutable state between
  them, so adding symbols/timeframes scales linearly.

## Scaling notes

- **Vertical:** the light/full split keeps per-tick cost ~O(cells). Benchmarked
  ~10k ticks/sec/core.
- **Horizontal:** Redis pub/sub is the natural seam to split ingest workers from
  API/WS servers; the cache already holds the snapshot each WS client needs.
- **Storage:** `ticks` is the high-volume table — partition by day / use
  TimescaleDB hypertables in production.
