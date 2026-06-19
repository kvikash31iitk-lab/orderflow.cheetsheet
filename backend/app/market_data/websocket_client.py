"""Market-data client: TrueData WebSocket SDK with a synthetic-feed fallback.

Responsibilities (per spec):
  * connect to TrueData (port 8086) via the official truedata_ws SDK
  * auto-reconnect (SDK-native) + our own heartbeat / staleness monitor
  * buffer ticks across a thread boundary (SDK callback thread -> asyncio)
  * expose a live ConnectionStatus widget feed
  * historical loading (get_history)
  * graceful fallback to a deterministic random-walk simulator so the whole
    terminal is usable when the market is closed or creds are unavailable

The client emits **raw tick dicts**:
    {symbol, timestamp(ms), price, volume, bid, ask}
Downstream (main pipeline) classifies side, aggregates and persists.
"""
from __future__ import annotations

import asyncio
import logging
import queue
import random
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from ..config import Settings, settings as default_settings
from .databento_client import DatabentoClient

log = logging.getLogger("market_data.client")

OnTick = Callable[[dict], Awaitable[None]]

# Rough base prices for the simulator so charts look plausible offline.
_SIM_BASE_PRICE = {
    "NIFTY-I": 23990.0,
    "BANKNIFTY-I": 51200.0,
    "FINNIFTY-I": 23100.0,
    "MIDCPNIFTY-I": 12600.0,
    "SENSEX-I": 78900.0,
}
_SIM_TICK = {"NIFTY-I": 0.05, "BANKNIFTY-I": 0.05}
_SIM_DEFAULT_BASE = 1000.0


@dataclass
class ConnectionStatus:
    state: str = "disconnected"          # connected | reconnecting | disconnected
    source: str = "none"                 # truedata | simulator | none
    symbols: list[str] = field(default_factory=list)
    last_tick_ms: int = 0
    tick_count: int = 0
    connected_since_ms: int = 0
    message: str = ""
    # symbols on real data vs. the synthetic fallback (populated from the Databento
    # side of the router so the UI can badge per-symbol live/simulated state).
    live_symbols: list[str] = field(default_factory=list)
    sim_symbols: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        now = int(time.time() * 1000)
        return {
            "state": self.state,
            "source": self.source,
            "symbols": self.symbols,
            "liveSymbols": self.live_symbols,
            "simSymbols": self.sim_symbols,
            "lastTickMs": self.last_tick_ms,
            "tickCount": self.tick_count,
            "connectedSinceMs": self.connected_since_ms,
            "staleMs": (now - self.last_tick_ms) if self.last_tick_ms else None,
            "message": self.message,
        }


class TrueDataClient:
    HEARTBEAT_INTERVAL = 5.0     # seconds between staleness checks
    STALE_AFTER = 15.0           # seconds without a tick => mark stale

    def __init__(
        self,
        on_tick: OnTick,
        symbols: Optional[list[str]] = None,
        cfg: Optional[Settings] = None,
    ) -> None:
        self.cfg = cfg or default_settings
        self.symbols = [s.upper() for s in (symbols or self.cfg.symbols)]
        self.on_tick = on_tick
        self.status = ConnectionStatus(symbols=self.symbols)

        self._td = None                       # truedata_ws.TD instance
        self._raw_q: "queue.Queue[dict]" = queue.Queue(maxsize=100_000)
        self._tasks: list[asyncio.Task] = []
        self._running = False
        # Set True if a TrueData connect times out and we fall back; a late
        # (post-timeout) SDK session must then NOT mix real ticks into the feed.
        self._connect_abandoned = False

    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        self._running = True
        connected = False
        if not self.cfg.force_simulator:
            connected = await self._start_truedata()
        if not connected:
            if self.cfg.force_simulator or self.cfg.use_simulator_fallback:
                await self._start_simulator()
            else:
                self.status.state = "disconnected"
                self.status.message = "TrueData connect failed and simulator disabled."
                log.error(self.status.message)
                return

        self._tasks.append(asyncio.create_task(self._drain_queue(), name="md-drain"))
        self._tasks.append(asyncio.create_task(self._heartbeat(), name="md-heartbeat"))

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()
        if self._td is not None:
            try:
                self._td.disconnect()
            except Exception:  # pragma: no cover - SDK best effort
                pass
            self._td = None
        self.status.state = "disconnected"

    # ------------------------------------------------------------------ #
    async def _start_truedata(self) -> bool:
        try:
            from truedata_ws.websocket.TD import TD  # noqa: WPS433 (optional dep)
        except Exception as exc:  # pragma: no cover - dep not installed in dev
            log.warning("truedata_ws not importable (%s); will use fallback.", exc)
            return False

        loop = asyncio.get_running_loop()

        def _connect() -> bool:
            try:
                td = TD(
                    self.cfg.truedata_username,
                    self.cfg.truedata_password,
                    live_port=self.cfg.truedata_live_port,
                    url=self.cfg.truedata_url,
                    log_level=logging.WARNING,
                )
                # If we already timed out and fell back, don't attach a late session.
                if self._connect_abandoned:
                    try:
                        td.disconnect()
                    except Exception:  # pragma: no cover - SDK best effort
                        pass
                    return False
                td.start_live_data(self.symbols)

                @td.trade_callback
                def _cb(tick):  # runs in SDK thread
                    if self._connect_abandoned:
                        return
                    try:
                        self._raw_q.put_nowait(self._from_td(tick))
                    except queue.Full:
                        pass

                self._td = td
                return True
            except Exception as exc:
                log.warning("TrueData connect failed: %s", exc)
                return False

        # The SDK constructor blocks until it has a session; on "User Already
        # Connected" it retries forever. Bound the wait so a bad session falls
        # back to the simulator instead of hanging application startup.
        try:
            ok = await asyncio.wait_for(
                loop.run_in_executor(None, _connect),
                timeout=self.cfg.truedata_connect_timeout_s,
            )
        except asyncio.TimeoutError:
            self._connect_abandoned = True
            log.warning(
                "TrueData connect timed out after %ss; falling back to simulator.",
                self.cfg.truedata_connect_timeout_s,
            )
            return False
        if ok:
            self.status.state = "connected"
            self.status.source = "truedata"
            self.status.connected_since_ms = int(time.time() * 1000)
            self.status.message = f"TrueData live on port {self.cfg.truedata_live_port}"
            log.info(self.status.message)
        return ok

    @staticmethod
    def _from_td(tick) -> dict:
        """Map a truedata_ws tick object to our raw dict.

        Attribute names vary slightly across SDK versions, so each field is
        resolved against a list of candidate names (first present, non-None wins).
        """
        ts = _first_attr(tick, ("timestamp", "time", "datetime"))
        ts_ms = int(ts.timestamp() * 1000) if hasattr(ts, "timestamp") else int(time.time() * 1000)
        symbol = _first_attr(tick, ("symbol", "Symbol", "ticker"), "")
        return {
            "symbol": str(symbol).upper(),
            "timestamp": ts_ms,
            "price": float(_first_attr(tick, ("ltp", "price", "last_price", "last_traded_price"), 0.0) or 0.0),
            "volume": float(_first_attr(tick, ("ltq", "volume", "qty", "quantity", "last_qty"), 0) or 0),
            "bid": _opt_float(_first_attr(tick, ("best_bid_price", "bid", "bid_price", "bb", "best_bid"))),
            "ask": _opt_float(_first_attr(tick, ("best_ask_price", "ask", "ask_price", "ba", "best_ask"))),
        }

    # ------------------------------------------------------------------ #
    async def _start_simulator(self) -> None:
        self.status.state = "connected"
        self.status.source = "simulator"
        self.status.connected_since_ms = int(time.time() * 1000)
        self.status.message = "Synthetic feed (market closed / no TrueData)."
        log.info(self.status.message)
        for sym in self.symbols:
            self._tasks.append(asyncio.create_task(self._sim_symbol(sym), name=f"sim-{sym}"))

    async def _sim_symbol(self, symbol: str) -> None:
        price = _SIM_BASE_PRICE.get(symbol, _SIM_DEFAULT_BASE)
        tick = _SIM_TICK.get(symbol, 0.05)
        spread = tick * 2
        drift = 0.0
        while self._running:
            # mean-reverting random walk with occasional momentum bursts
            drift = drift * 0.9 + random.uniform(-1, 1) * tick
            price = max(tick, price + drift + random.uniform(-1, 1) * tick)
            price = round(price / tick) * tick
            bid = round((price - spread / 2) / tick) * tick
            ask = round((price + spread / 2) / tick) * tick
            # bias trade toward bid or ask to create realistic delta
            at_ask = random.random() < (0.5 + 0.15 * (1 if drift > 0 else -1))
            trade_price = ask if at_ask else bid
            vol = random.choice([1, 1, 2, 5, 10, 25, 50, 75])
            raw = {
                "symbol": symbol,
                "timestamp": int(time.time() * 1000),
                "price": float(trade_price),
                "volume": float(vol),
                "bid": float(bid),
                "ask": float(ask),
            }
            try:
                self._raw_q.put_nowait(raw)
            except queue.Full:
                pass
            await asyncio.sleep(random.uniform(0.03, 0.15))

    # ------------------------------------------------------------------ #
    async def _drain_queue(self) -> None:
        """Move raw ticks from the thread-safe queue into the async on_tick sink."""
        while self._running:
            try:
                raw = self._raw_q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.002)
                continue
            self.status.last_tick_ms = raw["timestamp"]
            self.status.tick_count += 1
            try:
                await self.on_tick(raw)
            except Exception:  # pragma: no cover - never let one bad tick kill ingest
                log.exception("on_tick handler error")

    async def _heartbeat(self) -> None:
        while self._running:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            if self.status.source != "truedata":
                continue
            now = time.time() * 1000
            if self.status.last_tick_ms and (now - self.status.last_tick_ms) > self.STALE_AFTER * 1000:
                self.status.state = "reconnecting"
                self.status.message = "No ticks recently; SDK auto-reconnect in progress."
                log.warning(self.status.message)
            elif self.status.last_tick_ms:
                self.status.state = "connected"

    # ------------------------------------------------------------------ #
    async def get_history(self, symbol: str, duration: str = "1 D", bar_size: str = "tick") -> list[dict]:
        """Historical load via the SDK, normalised to raw tick dicts.

        The truedata_ws SDK returns *objects* (attribute access), but downstream
        consumers (e.g. the replay backfill) expect the same raw-dict shape as the
        live feed: {symbol, timestamp, price, volume, bid, ask}. We map every record
        here so callers never have to know the SDK's record type.
        """
        if self._td is None:
            return []
        loop = asyncio.get_running_loop()

        def _fetch():
            try:
                return self._td.get_historic_data(symbol, duration=duration, bar_size=bar_size, bidask=True)
            except Exception as exc:  # pragma: no cover
                log.warning("history fetch failed for %s: %s", symbol, exc)
                return []

        raw = await loop.run_in_executor(None, _fetch) or []
        out: list[dict] = []
        for rec in raw:
            mapped = _history_record_to_raw(rec, symbol)
            if mapped is not None:
                out.append(mapped)
        return out


def _first_attr(obj, names: tuple[str, ...], default=None):
    """Return the first present, non-None attribute among `names`, else default."""
    for name in names:
        val = getattr(obj, name, None)
        if val is not None:
            return val
    return default


def _to_epoch_ms(ts) -> Optional[int]:
    """Coerce a datetime / epoch-seconds / epoch-ms value to epoch milliseconds."""
    if ts is None:
        return None
    if hasattr(ts, "timestamp"):  # datetime / pandas Timestamp
        try:
            return int(ts.timestamp() * 1000)
        except Exception:  # pragma: no cover
            return None
    try:
        v = float(ts)
    except (TypeError, ValueError):
        return None
    return int(v) if v >= 1e12 else int(v * 1000)  # >=1e12 already looks like ms


def _history_record_to_raw(rec, symbol: str) -> Optional[dict]:
    """Map a historical record (SDK object OR dict) to the raw tick-dict shape.

    Historic records don't always carry the symbol, so it is injected from the
    request. Returns None for records missing a usable timestamp or price.
    """
    if isinstance(rec, dict):
        ts = rec.get("timestamp", rec.get("time", rec.get("date")))
        price = rec.get("price", rec.get("ltp", rec.get("close")))
        vol = rec.get("volume", rec.get("ltq", rec.get("ttq", 0)))
        bid = rec.get("bid", rec.get("best_bid_price"))
        ask = rec.get("ask", rec.get("best_ask_price"))
        sym = rec.get("symbol") or symbol
    else:
        ts = _first_attr(rec, ("timestamp", "time", "datetime", "date"))
        price = _first_attr(rec, ("ltp", "price", "last_price", "last_traded_price", "close"))
        vol = _first_attr(rec, ("ltq", "volume", "qty", "quantity", "ttq", "last_qty"), 0)
        bid = _first_attr(rec, ("best_bid_price", "bid", "bid_price", "bb", "best_bid"))
        ask = _first_attr(rec, ("best_ask_price", "ask", "ask_price", "ba", "best_ask"))
        sym = _first_attr(rec, ("symbol", "ticker"), symbol)

    ts_ms = _to_epoch_ms(ts)
    if ts_ms is None or price is None:
        return None
    return {
        "symbol": str(sym).upper(),
        "timestamp": ts_ms,
        "price": float(price),
        "volume": float(vol or 0.0),
        "bid": _opt_float(bid),
        "ask": _opt_float(ask),
    }


def _opt_float(v) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


class MarketDataClient:
    def __init__(
        self,
        on_tick: OnTick,
        symbols: Optional[list[str]] = None,
        cfg: Optional[Settings] = None,
    ) -> None:
        self.cfg = cfg or default_settings
        self.on_tick = on_tick

        # Initialize the two clients
        self.truedata_client = TrueDataClient(
            on_tick=self._on_truedata_tick,
            symbols=self.cfg.truedata_symbols_list,
            cfg=self.cfg,
        )
        self.databento_client = DatabentoClient(
            on_tick=self._on_databento_tick,
            symbols=self.cfg.databento_symbols_list,
            cfg=self.cfg,
        )

        self.symbols = self.truedata_client.symbols + self.databento_client.symbols
        self.active_source = "truedata"

    @staticmethod
    def _from_td(tick) -> dict:
        return TrueDataClient._from_td(tick)

    async def _start_truedata(self) -> bool:
        return await self.truedata_client._start_truedata()

    @property
    def _connect_abandoned(self) -> bool:
        return self.truedata_client._connect_abandoned

    @_connect_abandoned.setter
    def _connect_abandoned(self, val: bool) -> None:
        self.truedata_client._connect_abandoned = val

    async def start(self) -> None:
        log.info("Starting MarketDataClient router (TrueData + Databento)...")
        await asyncio.gather(
            self.truedata_client.start(),
            self.databento_client.start(),
        )

    async def stop(self) -> None:
        log.info("Stopping MarketDataClient router...")
        await asyncio.gather(
            self.truedata_client.stop(),
            self.databento_client.stop(),
        )

    async def get_history(self, symbol: str, duration: str = "1 D", bar_size: str = "tick") -> list[dict]:
        sym = symbol.upper()
        if sym in self.cfg.databento_symbols_list:
            self.active_source = "databento"
            return await self.databento_client.get_history(sym, duration, bar_size)
        else:
            self.active_source = "truedata"
            return await self.truedata_client.get_history(sym, duration, bar_size)

    @property
    def status(self):
        # Stable merged status that does NOT depend on which feed ticked last.
        # Both feeds stream concurrently, so deriving the headline from the most
        # recent tick made the primary TrueData status flip/jump every second.
        # Headline state/source/message come from whichever feed is on a real
        # (non-simulator) source, preferring TrueData; counters are combined.
        td = self.truedata_client.status
        dbn = self.databento_client.status
        primary = td if td.source == "truedata" else (dbn if dbn.source == "databento" else td)
        return ConnectionStatus(
            state=primary.state,
            source=primary.source,
            symbols=td.symbols + dbn.symbols,
            last_tick_ms=max(td.last_tick_ms, dbn.last_tick_ms),
            tick_count=td.tick_count + dbn.tick_count,
            connected_since_ms=primary.connected_since_ms or td.connected_since_ms or dbn.connected_since_ms,
            message=primary.message,
            # live/sim split comes from the Databento side (TrueData symbols are
            # always real when its source is live); the UI badges Databento symbols.
            live_symbols=dbn.live_symbols,
            sim_symbols=dbn.sim_symbols,
        )

    async def _on_truedata_tick(self, tick: dict) -> None:
        await self.on_tick(tick)

    async def _on_databento_tick(self, tick: dict) -> None:
        await self.on_tick(tick)

