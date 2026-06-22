"""Central configuration, loaded from environment / .env via pydantic-settings.

Import the singleton `settings` everywhere — do not read os.environ directly so that
all tuning knobs live in one typed, documented place.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Supported aggregation timeframes. "tick" is a passthrough (no time bucketing).
# Values are minutes; 0 means tick-level. 1440 = 1 day.
TIMEFRAME_MINUTES: dict[str, int] = {
    "tick": 0,
    "1m": 1,
    "2m": 2,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "4h": 240,
    "1D": 1440,
}

# Sub-minute ("N-second") timeframes are NOT part of the live aggregation / chart set
# (they stay out of TIMEFRAME_MINUTES so they never appear in the chart selector or get
# continuously generated + persisted). They are reconstructed ON DEMAND from stored
# ticks for indicator lower-timeframe orderflow (e.g. SC1 V4's 5S child bars). The
# `/api/footprints` endpoint routes a seconds timeframe to pipeline.snapshot_seconds.
_SECONDS_TF_RE = re.compile(r"^(\d+)\s*[sS]$")


def is_seconds_timeframe(tf: str) -> bool:
    """True for an N-second timeframe like '5s'/'5S' (1..59s), which is served on
    demand from ticks rather than from stored minute candles."""
    if not isinstance(tf, str):
        return False
    m = _SECONDS_TF_RE.match(tf.strip())
    if not m:
        return False
    secs = int(m.group(1))
    return 1 <= secs <= 59


def timeframe_to_ms(tf: str) -> Optional[int]:
    """Bucket size in milliseconds for a timeframe, or None if unrecognized.

    Supports the minute keys in TIMEFRAME_MINUTES ('tick' -> 0) PLUS N-second
    timeframes ('5s'/'5S' -> 5000). Returns an int so bucket boundaries stay exact
    integer epoch-ms (no float drift)."""
    if isinstance(tf, str) and tf in TIMEFRAME_MINUTES:
        return TIMEFRAME_MINUTES[tf] * 60_000
    if isinstance(tf, str):
        m = _SECONDS_TF_RE.match(tf.strip())
        if m:
            secs = int(m.group(1))
            if 1 <= secs <= 59:
                return secs * 1000
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- TrueData ---
    # Secrets default to empty — provide real values via .env (never hard-code here).
    truedata_username: str = ""
    truedata_password: str = ""
    truedata_live_port: int = 8086
    truedata_url: str = "push.truedata.in"
    truedata_symbols: str = "NIFTY-I,BANKNIFTY-I,FINNIFTY-I,MIDCPNIFTY-I"
    use_simulator_fallback: bool = True
    force_simulator: bool = False
    # Max seconds to wait for the TrueData SDK to establish a session before we
    # give up and fall back. The SDK blocks (and on "User Already Connected" it
    # retries forever), so without this bound a bad session hangs app startup.
    truedata_connect_timeout_s: float = 20.0

    # --- Databento ---
    databento_api_key: str = ""
    databento_symbols: str = "6E.v.0,GC.v.0"
    # Optional subscription-symbol -> display-symbol aliases. This lets us subscribe
    # to an explicitly active raw CME contract (e.g. GCQ6) while keeping the app's
    # stable continuous display symbol (GC.V.0) when Databento's live continuous map
    # lags or points at a stale contract.
    databento_symbol_aliases: str = ""

    # --- PostgreSQL ---
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "orderflow"
    postgres_user: str = "orderflow"
    postgres_password: str = "orderflow_pw"

    # --- Redis ---
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_db: int = 0

    # --- Candle snapshot limits ---
    # Footprint candles carry per-price cells, so a snapshot is a heavy payload.
    # These bound how many candles /api/footprints and a WS subscribe return; the
    # frontend asks for default_snapshot_limit and the server hard-clamps to
    # max_snapshot_limit so no client can request an unbounded payload.
    default_snapshot_limit: int = 15000
    websocket_snapshot_limit: int = 15000
    max_snapshot_limit: int = 25000
    # On-demand sub-minute (e.g. 5s) reconstruction from ticks: hard caps so a request
    # can't fan out into millions of buckets or an unbounded tick scan. 25000 5s bars
    # ~= 34.7h; the tick fetch is additionally bounded to the most-recent N ticks.
    max_seconds_snapshot_limit: int = 25000
    seconds_tick_fetch_cap: int = 1_500_000

    # --- Engine tuning ---
    default_timeframe: str = "2m"
    # Exchange timezone offset (minutes east of UTC) used to anchor the daily VWAP
    # session reset to the exchange's calendar day, independent of the host clock.
    # 330 = IST (UTC+5:30); use e.g. -300 for US Eastern (EST), 0 for UTC.
    exchange_timezone_offset_minutes: int = 330
    # Exchange session open ("HH:MM" in exchange-local time). The daily VWAP/session
    # resets at this time, not calendar midnight, e.g. "09:15" for NSE. "00:00"
    # keeps the reset at exchange midnight.
    exchange_session_start: str = "00:00"
    imbalance_ratio: float = 3.0
    imbalance_min_volume: int = 50
    stacked_imbalance_count: int = 3
    absorption_volume_std: float = 2.0
    absorption_max_range_ticks: int = 2
    exhaustion_volume_fraction: float = 0.35
    ad_delta_percentile: float = 90.0
    ad_rolling_window: int = 50
    lp_volume_std: float = 2.0
    lp_max_body_fraction: float = 0.30
    volume_cluster_percentile: float = 95.0

    # --- Alerts ---
    alerts_enabled: bool = True
    alert_sound_enabled: bool = True
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    discord_webhook_url: str = ""
    whatsapp_webhook_url: str = ""

    # --- App ---
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "INFO"
    tick_recording_dir: str = "./data/ticks"
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # ----- derived helpers -----
    @property
    def symbols(self) -> list[str]:
        td_syms = [s.strip().upper() for s in self.truedata_symbols.split(",") if s.strip()]
        return td_syms + self.databento_display_symbols_list

    @property
    def truedata_symbols_list(self) -> list[str]:
        return [s.strip().upper() for s in self.truedata_symbols.split(",") if s.strip()]

    @property
    def databento_symbols_list(self) -> list[str]:
        return [s.strip().upper() for s in self.databento_symbols.split(",") if s.strip()]

    @property
    def databento_symbol_alias_map(self) -> dict[str, str]:
        aliases: dict[str, str] = {}
        for item in self.databento_symbol_aliases.split(","):
            part = item.strip()
            if not part:
                continue
            if ":" in part:
                src, dst = part.split(":", 1)
            elif "=" in part:
                src, dst = part.split("=", 1)
            else:
                continue
            src = src.strip().upper()
            dst = dst.strip().upper()
            if src and dst:
                aliases[src] = dst
        return aliases

    @property
    def databento_display_symbols_list(self) -> list[str]:
        aliases = self.databento_symbol_alias_map
        out: list[str] = []
        seen: set[str] = set()
        for sym in self.databento_symbols_list:
            display = aliases.get(sym, sym).upper()
            if display not in seen:
                out.append(display)
                seen.add(display)
        return out

    @property
    def cors_origin_list(self) -> list[str]:
        return [s.strip() for s in self.cors_origins.split(",") if s.strip()]

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def redis_url(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_db}"

    @field_validator("default_timeframe")
    @classmethod
    def _valid_tf(cls, v: str) -> str:
        if v not in TIMEFRAME_MINUTES:
            raise ValueError(f"default_timeframe must be one of {list(TIMEFRAME_MINUTES)}")
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
