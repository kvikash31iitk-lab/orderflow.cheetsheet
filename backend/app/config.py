"""Central configuration, loaded from environment / .env via pydantic-settings.

Import the singleton `settings` everywhere — do not read os.environ directly so that
all tuning knobs live in one typed, documented place.
"""
from __future__ import annotations

from functools import lru_cache

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
        db_syms = [s.strip().upper() for s in self.databento_symbols.split(",") if s.strip()]
        return td_syms + db_syms

    @property
    def truedata_symbols_list(self) -> list[str]:
        return [s.strip().upper() for s in self.truedata_symbols.split(",") if s.strip()]

    @property
    def databento_symbols_list(self) -> list[str]:
        return [s.strip().upper() for s in self.databento_symbols.split(",") if s.strip()]

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
