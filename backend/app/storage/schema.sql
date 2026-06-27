-- ============================================================================
-- Vikings Order Flow Terminal — PostgreSQL schema
-- Loaded automatically on first container init (see docker-compose.yml).
-- Time columns are epoch milliseconds (BIGINT) to match the wire format.
-- ============================================================================

-- Raw tick-by-tick prints (every tick stored locally, per spec).
CREATE TABLE IF NOT EXISTS ticks (
    id        BIGSERIAL PRIMARY KEY,
    symbol    TEXT        NOT NULL,
    ts        BIGINT      NOT NULL,
    price     DOUBLE PRECISION NOT NULL,
    volume    DOUBLE PRECISION NOT NULL,
    bid       DOUBLE PRECISION,
    ask       DOUBLE PRECISION,
    side      TEXT        NOT NULL DEFAULT 'NEUTRAL'
);
CREATE INDEX IF NOT EXISTS ix_ticks_symbol_ts ON ticks (symbol, ts);

-- Finished footprint candles. Cells + signals kept as JSONB for fast replay
-- while flat columns power scanning / aggregation.
CREATE TABLE IF NOT EXISTS footprints (
    id               BIGSERIAL PRIMARY KEY,
    symbol           TEXT   NOT NULL,
    timeframe        TEXT   NOT NULL,
    start_time       BIGINT NOT NULL,
    end_time         BIGINT NOT NULL,
    row_size         DOUBLE PRECISION NOT NULL,
    open             DOUBLE PRECISION NOT NULL,
    high             DOUBLE PRECISION NOT NULL,
    low              DOUBLE PRECISION NOT NULL,
    close            DOUBLE PRECISION NOT NULL,
    total_volume     DOUBLE PRECISION NOT NULL,
    bid_volume       DOUBLE PRECISION NOT NULL,
    ask_volume       DOUBLE PRECISION NOT NULL,
    delta            DOUBLE PRECISION NOT NULL,
    cum_delta        DOUBLE PRECISION NOT NULL,
    poc              DOUBLE PRECISION,
    market_structure TEXT,
    cells            JSONB NOT NULL,
    signals          JSONB NOT NULL,
    -- row_size in the key so a consolidated candle can never overwrite the base row
    UNIQUE (symbol, timeframe, start_time, row_size)
);
CREATE INDEX IF NOT EXISTS ix_fp_symbol_tf_start ON footprints (symbol, timeframe, start_time);

-- Per-candle delta + cumulative delta (broken out for the histogram queries).
CREATE TABLE IF NOT EXISTS delta (
    id         BIGSERIAL PRIMARY KEY,
    symbol     TEXT   NOT NULL,
    timeframe  TEXT   NOT NULL,
    start_time BIGINT NOT NULL,
    delta      DOUBLE PRECISION NOT NULL,
    UNIQUE (symbol, timeframe, start_time)
);

CREATE TABLE IF NOT EXISTS cum_delta (
    id         BIGSERIAL PRIMARY KEY,
    symbol     TEXT   NOT NULL,
    timeframe  TEXT   NOT NULL,
    start_time BIGINT NOT NULL,
    cum_delta  DOUBLE PRECISION NOT NULL,
    UNIQUE (symbol, timeframe, start_time)
);

-- Signal occurrence tables (also feed the AD/LP research win-rate measurement).
CREATE TABLE IF NOT EXISTS absorption (
    id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    start_time BIGINT NOT NULL, price DOUBLE PRECISION, side TEXT
);
CREATE TABLE IF NOT EXISTS exhaustion (
    id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    start_time BIGINT NOT NULL, kind TEXT
);
CREATE TABLE IF NOT EXISTS lp_signals (
    id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    start_time BIGINT NOT NULL, side TEXT, price DOUBLE PRECISION,
    -- research metrics, filled in by validation jobs
    mae DOUBLE PRECISION, mfe DOUBLE PRECISION, outcome TEXT
);
CREATE TABLE IF NOT EXISTS ad_signals (
    id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    start_time BIGINT NOT NULL, delta_value DOUBLE PRECISION,
    mae DOUBLE PRECISION, mfe DOUBLE PRECISION, outcome TEXT
);
CREATE TABLE IF NOT EXISTS imbalances (
    id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    start_time BIGINT NOT NULL, direction TEXT,
    start_price DOUBLE PRECISION, end_price DOUBLE PRECISION, cell_count INT
);

CREATE INDEX IF NOT EXISTS ix_absorption_sym ON absorption (symbol, timeframe, start_time);
CREATE INDEX IF NOT EXISTS ix_exhaustion_sym ON exhaustion (symbol, timeframe, start_time);
CREATE INDEX IF NOT EXISTS ix_lp_sym ON lp_signals (symbol, timeframe, start_time);
CREATE INDEX IF NOT EXISTS ix_ad_sym ON ad_signals (symbol, timeframe, start_time);
CREATE INDEX IF NOT EXISTS ix_imb_sym ON imbalances (symbol, timeframe, start_time);

-- Alert log (popup/sound/telegram/discord/whatsapp fan-out source of truth).
CREATE TABLE IF NOT EXISTS alerts (
    id        BIGSERIAL PRIMARY KEY,
    ts        BIGINT NOT NULL,
    symbol    TEXT   NOT NULL,
    timeframe TEXT,
    type      TEXT   NOT NULL,
    severity  TEXT   NOT NULL DEFAULT 'info',
    message   TEXT   NOT NULL,
    payload   JSONB
);
CREATE INDEX IF NOT EXISTS ix_alerts_ts ON alerts (ts DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_symbol ON alerts (symbol, ts DESC);

-- Workspace / layout presets (Phase 3B backend sync). Frontend-authored WorkspacePresetV1 JSON only —
-- never candles/ticks/scanner/alerts/positions/orders/fills/feed-state/secrets (the API rejects those).
-- No auth on this backend, so presets are GLOBAL (shared by all clients); `profile` is a soft scope label.
-- `id` is the client-supplied preset id (ws_*) so a pushed local preset keeps its identity across devices.
CREATE TABLE IF NOT EXISTS workspace_presets (
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT,
    profile     TEXT    NOT NULL DEFAULT 'Default',
    version     INTEGER NOT NULL DEFAULT 1,
    preset_json JSONB   NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  BIGINT  NOT NULL,
    updated_at  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_workspace_presets_active ON workspace_presets (is_archived, updated_at DESC);
