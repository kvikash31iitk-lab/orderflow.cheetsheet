"""Exchange trading-session boundaries (DST-correct via zoneinfo).

A single global UTC offset can't model CME, which trades in U.S. Central Time and
observes DST. This module maps each symbol to a session PROFILE and exposes:

    get_session_id(symbol, ts_ms)     -> trading-day id, e.g. "CME-2026-06-19"
    get_session_bounds(symbol, ts_ms) -> (open_ms, close_ms) of that session
    in_session(symbol, ts_ms)         -> False during the daily maintenance break

VWAP and cumulative delta reset whenever get_session_id() changes. Timestamps stay
epoch-UTC; only the trading-day classification is timezone-aware.

CME Globex (GC, 6E): regular session opens 17:00 CT (previous calendar day) and
closes 16:00 CT, with a 16:00-17:00 CT daily maintenance break. The trade date rolls
at 17:00 CT (so 17:00 Sun CT belongs to Monday's session). Holiday hours can vary —
the regular session is modelled here; holiday exceptions are a future addition (see
HOLIDAY note below) and are NOT silently special-cased.

NSE (NIFTY etc.): 09:15-15:30 IST, no DST, no break.

Refs: cmegroup.com/trading-hours.html, gold/euro-fx contract specs.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Optional
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class SessionProfile:
    exchange: str
    tz: tzinfo  # concrete tzinfo (ZoneInfo for DST exchanges, fixed offset for fallback)
    open_min: int  # session open, minutes from local midnight
    close_min: int  # session close, minutes from local midnight
    overnight: bool  # True if the session opens in the evening and closes the next day (CME)


NSE = SessionProfile("NSE", ZoneInfo("Asia/Kolkata"), 9 * 60 + 15, 15 * 60 + 30, overnight=False)
CME = SessionProfile("CME", ZoneInfo("America/Chicago"), 17 * 60, 16 * 60, overnight=True)

# symbol -> profile. Continuous ".V.0" forms are matched case-insensitively. Unknown
# symbols fall back to the config offset (see profile_for / _config_profile).
_SYMBOL_PROFILE: dict[str, SessionProfile] = {
    "GC.V.0": CME,
    "6E.V.0": CME,
    "NIFTY-I": NSE,
    "BANKNIFTY-I": NSE,
    "FINNIFTY-I": NSE,
    "MIDCPNIFTY-I": NSE,
    "SENSEX-I": NSE,
}

# HOLIDAY note: CME has shortened/closed holiday sessions. A future-safe override would
# be a {date: (open_min, close_min) | None} table consulted here; intentionally omitted
# now to avoid overbuilding. Regular sessions stay correct.


def _parse_hhmm(s: str) -> int:
    try:
        h, m = map(int, (s or "00:00").split(":"))
        return h * 60 + m
    except (ValueError, AttributeError):
        return 0


def _config_profile(cfg: Any) -> SessionProfile:
    """Fallback for symbols without a known exchange profile: a fixed-offset session
    built from the legacy config knobs (exchange_timezone_offset_minutes +
    exchange_session_start). Preserves the pre-profile behavior for unknown symbols."""
    off = int(getattr(cfg, "exchange_timezone_offset_minutes", 0) or 0)
    start = _parse_hhmm(getattr(cfg, "exchange_session_start", "00:00"))
    return SessionProfile("EX", timezone(timedelta(minutes=off)), start, start, overnight=False)


def profile_for(symbol: str, cfg: Optional[Any] = None) -> SessionProfile:
    known = _SYMBOL_PROFILE.get(symbol.upper())
    if known is not None:
        return known
    return _config_profile(cfg) if cfg is not None else NSE


def _local(p: SessionProfile, ts_ms: int) -> datetime:
    return datetime.fromtimestamp(ts_ms / 1000.0, tz=p.tz)


def _trade_date(p: SessionProfile, local: datetime) -> date:
    mod = local.hour * 60 + local.minute
    if p.overnight:
        # trade date rolls forward at the evening open (17:00 CT -> next day's session)
        return local.date() + timedelta(days=1) if mod >= p.open_min else local.date()
    # same-day session: before the open belongs to the prior trading day
    return local.date() if mod >= p.open_min else local.date() - timedelta(days=1)


def get_session_id(symbol: str, ts_ms: int, cfg: Optional[Any] = None) -> str:
    """Stable id for the trading session a timestamp belongs to (resets VWAP/CVD)."""
    p = profile_for(symbol, cfg)
    return f"{p.exchange}-{_trade_date(p, _local(p, ts_ms)).isoformat()}"


def in_session(symbol: str, ts_ms: int, cfg: Optional[Any] = None) -> bool:
    """False during the daily maintenance break / outside regular hours."""
    p = profile_for(symbol, cfg)
    local = _local(p, ts_ms)
    mod = local.hour * 60 + local.minute
    if p.overnight:
        return mod >= p.open_min or mod < p.close_min
    return p.open_min <= mod < p.close_min


def get_session_bounds(symbol: str, ts_ms: int, cfg: Optional[Any] = None) -> tuple[int, int]:
    """(open_ms, close_ms) epoch-ms bounds of the session `ts_ms` falls in."""
    p = profile_for(symbol, cfg)
    tz = p.tz
    td = _trade_date(p, _local(p, ts_ms))

    def _ms(d: date, minute: int) -> int:
        dt = datetime(d.year, d.month, d.day, minute // 60, minute % 60, tzinfo=tz)
        return int(dt.timestamp() * 1000)

    if p.overnight:
        return _ms(td - timedelta(days=1), p.open_min), _ms(td, p.close_min)
    return _ms(td, p.open_min), _ms(td, p.close_min)
