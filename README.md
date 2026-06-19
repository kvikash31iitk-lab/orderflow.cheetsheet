# Vikings Order Flow Terminal

A professional, real-time **footprint order-flow** trading terminal in the style of
GoCharting, powered by **TrueData** tick-by-tick market data.

It ingests tick data, classifies aggressor side, builds footprint candles
(bid × ask volume per price level), and computes institutional-grade order-flow
analytics — delta, cumulative delta, imbalances, stacked imbalances, absorption,
exhaustion, **LP (Liquidity Provider)** and **AD (Aggressive Delta)** detection,
volume nodes, and market structure — rendered live on a custom **WebGL (PixiJS)**
footprint engine.

> Reference UI: GoCharting Footprint Order Flow (see project brief screenshot).

---

## ✨ Features

| # | Feature | Status |
|---|---------|--------|
| 1 | Footprint charts (bid × ask per price row) | ✅ |
| 2 | Bid × Ask volume profile per candle | ✅ |
| 3 | Delta + delta histogram | ✅ |
| 4 | Cumulative delta | ✅ |
| 5 | Volume imbalance (≥ ratio) + cell highlight | ✅ |
| 6 | Stacked imbalance zones (≥ 3 consecutive) | ✅ |
| 7 | Absorption detection (A badge) | ✅ |
| 8 | Exhaustion detection (E badge) | ✅ |
| 9 | LP detection (support/resistance) | ✅ |
| 10 | AD (Aggressive Delta) detection | ✅ |
| 11 | High / Low Volume Nodes (HVN/LVN) | ✅ |
| 12 | Volume clusters (rolling percentile) | ✅ |
| 13 | Market structure (HH/HL/LH/LL + trend) | ✅ |
| 14 | Real-time alerts (popup, sound, Telegram, Discord, WhatsApp) | ✅ |
| 15 | Order-flow scanner across symbols | ✅ |
| 16 | Historical replay (1×–50× + step) | ✅ |
| — | Auto-reconnect, heartbeat, tick recording, connection widget | ✅ |
| — | Simulator fallback (works when market is closed) | ✅ |

---

## 🏗 Architecture

```
                    ┌──────────────────────────────────────────────────────┐
   TrueData WS ────▶│  MarketDataClient  (truedata_ws SDK | simulator)      │
   (port 8086)      │  auto-reconnect · heartbeat · thread→async buffering  │
                    └───────────────┬──────────────────────────────────────┘
                                    │ raw ticks {symbol,ts,price,vol,bid,ask}
                                    ▼
                    ┌──────────────────────────────────────────────────────┐
                    │  Pipeline (hot path, in-memory only)                  │
                    │   TickHandler   → classify BUY/SELL (price≥ask/≤bid)  │
                    │   TickRecorder  → parquet (every tick stored)         │
                    │   AggregatorManager → footprint candles / timeframe   │
                    │        └─ OrderFlowEngine (delta, imbalance,          │
                    │           absorption, exhaustion, LP, AD, nodes,      │
                    │           cum-delta, market structure)                │
                    └───────┬───────────────────────────┬──────────────────┘
        closed candle       │                           │ throttled live candle (8 Hz)
        ┌───────────────────▼─────────┐                 ▼
        │ PostgreSQL  Redis  Alerts   │        ConnectionManager (WS fan-out)
        │ (durable)   (cache) (fan-out)│                 │
        └─────────────────────────────┘                 ▼
                                          React + Zustand + PixiJS footprint UI
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full module map and data flow.

---

## 🚀 Quick start (Docker)

```bash
cp .env.example .env          # trial TrueData creds are pre-filled
docker compose up --build
```

- Frontend: <http://localhost:5173>
- Backend API + docs: <http://localhost:8000/docs>
- WebSocket: `ws://localhost:8000/ws`

PostgreSQL (`:5432`) and Redis (`:6379`) come up automatically; the schema is
applied on first boot. If TrueData is unreachable or the market is closed, the
backend automatically streams a **synthetic feed** so the whole terminal still works.

### Manual dev (no Docker)

See **[INSTALL.md](INSTALL.md)** for Windows step-by-step. In short:

```bash
# backend
cd backend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload          # needs Postgres+Redis, or runs degraded

# frontend
cd frontend
npm install
npm run dev
```

---

## 🔌 Data source — TrueData

Configured in `.env`:

```
TRUEDATA_USERNAME=your_truedata_username
TRUEDATA_PASSWORD=your_truedata_password
TRUEDATA_LIVE_PORT=8086
TRUEDATA_SYMBOLS=NIFTY-I,BANKNIFTY-I,FINNIFTY-I,MIDCPNIFTY-I
USE_SIMULATOR_FALLBACK=true   # synthetic feed when TrueData is down
FORCE_SIMULATOR=false         # set true for fully offline dev
```

> Placeholders only. Put **real** credentials/keys (TrueData, Databento, webhooks)
> in a local `.env`, which is gitignored and never committed.

Aggressor classification uses tick-level top-of-book: `price ≥ ask → BUY`,
`price ≤ bid → SELL`, with a Lee-Ready tick-rule fallback when a trade prints
between the quotes.

---

## 🎨 Signal / color legend

| Element | Meaning | Color |
|--------|---------|-------|
| Cell green | Aggressive buying (ask > bid) | green, intensity = volume |
| Cell red | Aggressive selling (bid > ask) | red, intensity = volume |
| Bright edge | Imbalance cell (≥ 3:1) | bright green / red |
| Yellow outline | POC (point of control) | gold |
| `LP` badge | Liquidity Provider | green = support, red = resistance |
| `AD` badge | Aggressive Delta | turquoise |
| `A` badge | Absorption | purple |
| `E` badge | Exhaustion | yellow |
| Vertical box | Stacked imbalance zone | green / red outline |

---

## 🧠 Engine tuning

All thresholds are env-configurable (`.env` → `app/config.py`): imbalance ratio,
stacked count, absorption volume σ + max range, exhaustion volume fraction,
AD percentile + window, LP volume σ + body fraction, volume-cluster percentile.
The signal tables (`absorption`, `lp_signals`, `ad_signals`, …) include
`mae`/`mfe`/`outcome` columns to support the **AD/LP research module**
(win-rate / expectancy / MAE / MFE validation).

---

## 📡 API

**REST** (`/api`): `health`, `status`, `symbols`, `timeframes`,
`footprints?symbol&timeframe&limit`, `scanner`, `alerts`,
`replay/load|play|pause|step|stop`, `timeframe/add`.

**WebSocket** (`/ws`): server pushes
`{type: "snapshot"|"candle"|"status"|"alert"|"replay"}`.
Client sends `{action:"subscribe", symbol, timeframe}` to filter the stream.

---

## ⚡ Performance

Benchmark (single core, full classify → footprint → engine hot path):

```
python -m scripts.benchmark 200000 1 2m
→ ~10,000 ticks/sec  ≈  600,000 ticks/min   (6× the 100k/min target)
```

Heavy percentile detectors run once per bar (at close); the live candle uses a
cheap path (delta, cum-delta, imbalance, nodes). DB writes and WS broadcasts are
batched off the hot path; the frontend renders incrementally on WebGL.

---

## 📁 Project structure

```
backend/app/
  config.py              # typed settings (.env)
  market_data/           # websocket_client, tick_handler, aggregator
  orderflow/             # models, footprint, delta, imbalance, absorption,
                         #   exhaustion, lp_detection, ad_detection,
                         #   market_structure, engine
  storage/               # postgres, redis_cache, recorder, schema.sql
  alerts/                # alert_engine, notifiers
  replay/                # replay_engine
  api/                   # websocket (fan-out), routes (REST)
  pipeline.py            # wires everything together
  main.py                # FastAPI app + lifespan + /ws
backend/tests/           # unit tests (pytest)
backend/scripts/         # benchmark.py
frontend/src/
  charts/                # footprintRenderer (PixiJS) + FootprintChart
  dashboard/             # Header, Dashboard layout
  widgets/               # DeltaHistogram, CumDelta, Scanner, Alerts, Replay, Status
  store/ api/ types/     # Zustand store, WS/REST clients, wire types
docker-compose.yml
```

---

## ✅ Tests

```bash
cd backend && python -m pytest        # 19 tests: classification, footprint,
                                      # imbalance, aggregation, engine
cd frontend && npm run typecheck      # strict TS
```

---

## 📝 License / disclaimer

For research and educational use. Order-flow signals (esp. LP/AD) are
heuristics, not financial advice. Verify against your own data before trading.
