"""Market-data client: Databento WebSocket and Historical API.

Responsibilities:
  * Connect to Databento Live (DBEQ.BASIC for US Equities, GLBX.MDP3 for CME Futures)
  * Map symbology mappings via SymbolMappingMsg to instrument_ids
  * Buffer incoming ticks and parse MBP1Msg records to normalized tick dicts
  * Expose connection status matching ConnectionStatus interface
  * Backfill history using the Databento Historical client
  * Graceful simulator fallback for offline development
"""
from __future__ import annotations

import asyncio
import logging
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Awaitable, Callable, Optional

from ..config import Settings, settings as default_settings

log = logging.getLogger("market_data.databento")

OnTick = Callable[[dict], Awaitable[None]]

# Import databento dynamically. Catch *any* import-time failure (not just
# ImportError): the C-extension (databento-dbn) can raise OSError/RuntimeError on
# an ABI mismatch, and such a failure must NEVER crash backend startup and take
# the live TrueData terminal down.
try:
    import databento as db
    HAS_DATABENTO = True
except Exception as exc:  # noqa: BLE001 - resilient: never crash boot on the optional dep
    HAS_DATABENTO = False
    logging.getLogger("market_data.databento").warning(
        "databento not importable (%s); Databento symbols will use the simulator.", exc
    )

# Databento encodes "no price" as INT64_MAX; guard against scaling it to ~9.2e9.
try:
    from databento_dbn import UNDEF_PRICE
except Exception:  # noqa: BLE001
    UNDEF_PRICE = 9223372036854775807

# Base prices for the Databento simulator so offline charts look realistic
_SIM_BASE_PRICE = {
    "6E.V.0": 1.1520,   # EUR/USD approx (Sep quarterly)
    "GC.V.0": 4292.0,   # Gold USD/oz approx (Aug front month)
}
_SIM_TICK = {
    "6E.V.0": 0.00005,
    "GC.V.0": 0.10,
}
_SIM_DEFAULT_BASE = 100.0


@dataclass
class ConnectionStatus:
    state: str = "disconnected"          # connected | reconnecting | disconnected
    source: str = "none"                 # databento | simulator | none
    symbols: list[str] = field(default_factory=list)
    last_tick_ms: int = 0
    tick_count: int = 0
    connected_since_ms: int = 0
    message: str = ""
    # symbols streaming REAL Databento data vs. ones on the synthetic fallback
    # (e.g. a dataset the API key isn't entitlement-licensed for).
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


def resolve_databento_symbol(symbol: str) -> tuple[str, str]:
    """Resolve symbol to (dataset, stype_in) for Databento.

    Continuous contracts are identified by their DataBento suffix:
      .c.0  — calendar-roll continuous (rolls on expiry date)
      .v.0  — volume-roll continuous (rolls when the next contract overtakes in volume)
    Both route to GLBX.MDP3 with stype_in='continuous'.

    Standard US equities (AAPL, MSFT) route to DBEQ.BASIC with stype_in='raw_symbol'.
    The matching uses the dot-separated continuous form (e.g. .C. / .V.) rather than
    bare prefixes to avoid misrouting equities like ESTC or NQXT to the CME gateway.
    """
    sym = symbol.upper()
    if (
        ".C." in sym or sym.endswith(".C.0")
        or ".V." in sym or sym.endswith(".V.0")
        or sym.endswith(".F.US")
        or ".FUT" in sym
    ):
        return "GLBX.MDP3", "continuous"
    return "DBEQ.BASIC", "raw_symbol"


class DatabentoClient:
    HEARTBEAT_INTERVAL = 5.0
    STALE_AFTER = 15.0

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

        # Databento API key
        self.api_key = getattr(self.cfg, "databento_api_key", "")

        self.live_clients: dict[str, db.Live] = {}
        # Tick queue + the main event loop, both bound in start() on the running loop.
        # The SDK callback runs on Databento's background thread and hands records to
        # this loop via loop.call_soon_threadsafe (see _cb) — a plain thread queue +
        # poll silently delivered nothing inside uvicorn's loop, so we wake it explicitly.
        self._aq: "Optional[asyncio.Queue[tuple[str, any]]]" = None
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None
        self._cb_count = 0  # diagnostic: SDK callback invocations (records arriving)
        self._symbol_map: dict[int, str] = {}  # instrument_id -> subscribed symbol name
        self._tasks: list[asyncio.Task] = []
        self._running = False
        # symbols whose dataset couldn't connect live and run on the simulator instead
        self._sim_symbols: list[str] = []
        # datasets that timed out mid-connect; a late SDK session for one of these
        # must NOT feed the queue (would mix real ticks into the simulated feed).
        self._abandoned_datasets: set[str] = set()
        # serialises the connect-vs-timeout race across threads: the executor thread's
        # "is this dataset abandoned? if not, register the live client" must be atomic
        # w.r.t. the event loop's "mark abandoned + reclaim any registered client".
        self._connect_lock = threading.Lock()

    async def start(self) -> None:
        self._running = True
        # Capture the running (uvicorn) loop + create the tick queue ON it, so the
        # Databento SDK background thread can hand records back safely via
        # loop.call_soon_threadsafe.
        self._main_loop = asyncio.get_running_loop()
        self._aq = asyncio.Queue(maxsize=100_000)
        connected = False

        # If Databento is available and simulation is not forced, try to connect
        if HAS_DATABENTO and not getattr(self.cfg, "force_simulator", False) and self.api_key:
            connected = await self._start_databento()

        if not connected:
            if getattr(self.cfg, "force_simulator", False) or getattr(self.cfg, "use_simulator_fallback", True):
                await self._start_simulator()
            else:
                self.status.state = "disconnected"
                self.status.message = "Databento connection failed and simulator disabled."
                log.error(self.status.message)
                return

        self._tasks.append(asyncio.create_task(self._drain_queue(), name="db-drain"))
        self._tasks.append(asyncio.create_task(self._heartbeat(), name="db-heartbeat"))

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()

        for dataset, client in list(self.live_clients.items()):
            try:
                client.stop()
            except Exception:
                pass
        self.live_clients.clear()
        self.status.state = "disconnected"

    async def _start_databento(self) -> bool:
        """Connect each dataset INDEPENDENTLY.

        A failure on one dataset (e.g. DBEQ.BASIC US equities rejected for lack of a
        live-data licence) must NOT prevent another (e.g. GLBX.MDP3 CME futures, which
        IS entitled) from streaming real data. Symbols whose dataset can't connect fall
        back to the per-symbol simulator. Returns True if at least one dataset is live.
        """
        log.info("Starting Databento live stream connections...")
        loop = asyncio.get_running_loop()

        # Group symbols by dataset so we only connect to the gateways we need.
        symbols_by_dataset: dict[str, list[str]] = {}
        stype_by_dataset: dict[str, str] = {}
        for sym in self.symbols:
            dataset, stype_in = resolve_databento_symbol(sym)
            symbols_by_dataset.setdefault(dataset, []).append(sym)
            stype_by_dataset[dataset] = stype_in

        timeout_s = getattr(self.cfg, "truedata_connect_timeout_s", 20.0)
        self._sim_symbols = []

        for dataset, syms in symbols_by_dataset.items():
            stype_in = stype_by_dataset[dataset]
            log.info("Connecting to Databento Live gateway for %s with symbols %s", dataset, syms)

            # default args bind the per-iteration values into the executor closure.
            def _connect_one(ds=dataset, s=syms, st=stype_in) -> bool:
                # if this dataset already timed out and we fell back, don't attach a
                # late session that would double-feed the queue.
                if ds in self._abandoned_datasets:
                    return False
                try:
                    client = db.Live(key=self.api_key)
                    client.subscribe(dataset=ds, schema="tbbo", symbols=s, stype_in=st)

                    # callback runs in the SDK thread: drop ticks once this dataset is
                    # abandoned and swallow backpressure (mirrors the other guards).
                    def _cb(rec, _ds=ds):
                        # Runs on Databento's background thread. Hand the record to the
                        # main event loop via call_soon_threadsafe, which WAKES uvicorn's
                        # loop (a plain thread queue + 2ms poll silently delivered nothing
                        # here). _cb_count gives delivery visibility.
                        if _ds in self._abandoned_datasets:
                            return
                        self._cb_count += 1
                        loop = self._main_loop
                        if loop is None:
                            return
                        try:
                            loop.call_soon_threadsafe(self._enqueue, (_ds, rec))
                        except RuntimeError:
                            pass  # loop closed/closing during shutdown

                    client.add_callback(_cb)
                    # fast-path bail if already abandoned before the (blocking) start();
                    # the authoritative re-check happens under the lock below.
                    if ds in self._abandoned_datasets:
                        try:
                            client.stop()
                        except Exception:  # pragma: no cover - SDK best effort
                            pass
                        return False
                    client.start()
                    # Register atomically vs. the timeout handler. wait_for does NOT
                    # cancel this executor thread, so the awaiting coroutine may have
                    # timed out and abandoned this dataset while start() was blocking.
                    # Registering anyway would leak a metered live session and make the
                    # symbol report as BOTH live and simulated.
                    with self._connect_lock:
                        registered = ds not in self._abandoned_datasets
                        if registered:
                            self.live_clients[ds] = client
                    if not registered:
                        try:
                            client.stop()
                        except Exception:  # pragma: no cover - SDK best effort
                            pass
                        return False
                    return True
                except Exception as exc:  # entitlement / auth / network failure
                    log.warning(
                        "Databento Live: dataset %s failed (%s); symbols %s -> simulator.",
                        ds, exc, s,
                    )
                    return False

            try:
                ok = await asyncio.wait_for(
                    loop.run_in_executor(None, _connect_one), timeout=timeout_s
                )
            except asyncio.TimeoutError:
                # mark abandoned AND reclaim any client the executor thread registered
                # in the race window, atomically w.r.t. the thread's register step.
                with self._connect_lock:
                    self._abandoned_datasets.add(dataset)
                    leaked = self.live_clients.pop(dataset, None)
                if leaked is not None:
                    try:
                        leaked.stop()
                    except Exception:  # pragma: no cover - SDK best effort
                        pass
                log.warning(
                    "Databento Live: dataset %s timed out; symbols %s -> simulator.",
                    dataset, syms,
                )
                ok = False

            if not ok:
                self._sim_symbols.extend(syms)

        if not self.live_clients:
            # nothing connected live: let start() run the full-simulator fallback so
            # every symbol still gets a synthetic feed (and avoid double-starting sims).
            self._sim_symbols = []
            return False

        # Partial or full live success.
        live_symbols = [
            s
            for ds in self.live_clients
            if ds not in self._abandoned_datasets
            for s in symbols_by_dataset.get(ds, [])
        ]
        self.status.state = "connected"
        self.status.source = "databento"
        self.status.connected_since_ms = int(time.time() * 1000)
        self.status.live_symbols = live_symbols
        self.status.sim_symbols = list(self._sim_symbols)
        self.status.message = (
            f"Databento Live: {len(live_symbols)} live, {len(self._sim_symbols)} simulated"
            + (" (no entitlement)" if self._sim_symbols else "")
        )
        log.info(self.status.message)

        # Spin up the per-symbol simulator for the datasets that couldn't connect.
        for sym in self._sim_symbols:
            self._tasks.append(asyncio.create_task(self._sim_symbol(sym), name=f"db-sim-{sym}"))

        return True

    async def _start_simulator(self) -> None:
        self.status.state = "connected"
        self.status.source = "simulator"
        self.status.connected_since_ms = int(time.time() * 1000)
        self.status.message = "Synthetic feed (offline / no Databento)."
        self.status.live_symbols = []
        self.status.sim_symbols = list(self.symbols)
        log.info(self.status.message)
        for sym in self.symbols:
            self._tasks.append(asyncio.create_task(self._sim_symbol(sym), name=f"db-sim-{sym}"))

    async def _sim_symbol(self, symbol: str) -> None:
        price = _SIM_BASE_PRICE.get(symbol, _SIM_DEFAULT_BASE)
        tick = _SIM_TICK.get(symbol, 0.01)
        spread = tick * 2
        drift = 0.0
        while self._running:
            drift = drift * 0.9 + random.uniform(-1, 1) * tick
            price = max(tick, price + drift + random.uniform(-1, 1) * tick)
            price = round(price / tick) * tick
            bid = round((price - spread / 2) / tick) * tick
            ask = round((price + spread / 2) / tick) * tick
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
            self._enqueue(("", raw))
            await asyncio.sleep(random.uniform(0.05, 0.25))

    def _enqueue(self, item: "tuple[str, any]") -> None:
        """Put a (dataset, record) onto the asyncio queue. Always runs on the main
        loop — directly for simulator ticks, via call_soon_threadsafe for live SDK
        records arriving on Databento's background thread."""
        aq = self._aq
        if aq is None:
            return
        try:
            aq.put_nowait(item)
        except asyncio.QueueFull:
            pass  # backpressure: drop the newest record rather than block

    async def _drain_queue(self) -> None:
        """Single ordered consumer: pull ticks from the asyncio queue (woken by
        call_soon_threadsafe / simulator puts — no busy polling) into on_tick."""
        while self._running:
            if self._aq is None:
                await asyncio.sleep(0.05)
                continue
            try:
                dataset, record = await asyncio.wait_for(self._aq.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            # Handle simulator ticks directly
            if not dataset and isinstance(record, dict):
                self.status.last_tick_ms = record["timestamp"]
                self.status.tick_count += 1
                try:
                    await self.on_tick(record)
                except Exception:
                    log.exception("on_tick handler error in Databento simulator")
                continue

            # Parse Databento DBN records. Guarded so one malformed record can't
            # raise out of the drain task and silently stop the whole feed.
            try:
                rec_type = type(record).__name__

                if rec_type == "SymbolMappingMsg":
                    instrument_id = getattr(record, "instrument_id", None)
                    stype_in_symbol = getattr(record, "stype_in_symbol", None)
                    if instrument_id is not None and stype_in_symbol:
                        self._symbol_map[instrument_id] = stype_in_symbol.upper()
                    continue

                # Parse trade / MBP1 messages
                instrument_id = getattr(record, "instrument_id", None)
                if instrument_id is None:
                    continue

                symbol = self._symbol_map.get(instrument_id)
                if not symbol:
                    continue

                ts_event = getattr(record, "ts_event", None)
                price = getattr(record, "price", None)
                size = getattr(record, "size", None)
                if ts_event is None or price is None or size is None or price == UNDEF_PRICE:
                    continue

                price_val = float(price) * 1e-9
                vol_val = float(size)
                ts_ms = int(ts_event // 1_000_000)

                # Extract Bid / Ask if present (skip the INT64_MAX "no price" sentinel)
                bid_val = None
                ask_val = None
                levels = getattr(record, "levels", None)
                if levels and len(levels) > 0:
                    bid_px = getattr(levels[0], "bid_px", None)
                    ask_px = getattr(levels[0], "ask_px", None)
                    if bid_px is not None and bid_px != UNDEF_PRICE:
                        bid_val = float(bid_px) * 1e-9
                    if ask_px is not None and ask_px != UNDEF_PRICE:
                        ask_val = float(ask_px) * 1e-9

                raw_tick = {
                    "symbol": symbol,
                    "timestamp": ts_ms,
                    "price": price_val,
                    "volume": vol_val,
                    "bid": bid_val,
                    "ask": ask_val,
                }
            except Exception:
                log.exception("Databento record parse error; dropping record")
                continue

            self.status.last_tick_ms = ts_ms
            self.status.tick_count += 1
            try:
                await self.on_tick(raw_tick)
            except Exception:
                log.exception("on_tick handler error in Databento Live")

    async def _heartbeat(self) -> None:
        while self._running:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            # diagnostic: distinguishes "records not arriving" (cb_count flat) from
            # "arriving but not parsed/emitted" (cb_count rises, tick_count flat).
            log.info(
                "[databento-dbg] source=%s cb_count=%d tick_count=%d symbol_map=%d qsize=%s",
                self.status.source, self._cb_count, self.status.tick_count,
                len(self._symbol_map), self._aq.qsize() if self._aq is not None else "n/a",
            )
            if self.status.source != "databento":
                continue
            now = time.time() * 1000
            if self.status.last_tick_ms and (now - self.status.last_tick_ms) > self.STALE_AFTER * 1000:
                self.status.state = "reconnecting"
                self.status.message = "No ticks recently; Databento reconnect in progress."
                log.warning(self.status.message)
            elif self.status.last_tick_ms:
                self.status.state = "connected"

    async def get_history(self, symbol: str, duration: str = "1 D", bar_size: str = "tick") -> list[dict]:
        """Historical snapshot fetch via Databento Historical API."""
        if not HAS_DATABENTO or getattr(self.cfg, "force_simulator", False) or not self.api_key:
            return []

        # Parse duration
        parts = duration.strip().split()
        if len(parts) == 2:
            try:
                val = int(parts[0])
                unit = parts[1].upper()
                if unit.startswith("D"):
                    delta = timedelta(days=val)
                elif unit.startswith("H"):
                    delta = timedelta(hours=val)
                elif unit.startswith("M"):
                    delta = timedelta(minutes=val)
                else:
                    delta = timedelta(days=1)
            except ValueError:
                delta = timedelta(days=1)
        else:
            delta = timedelta(days=1)

        end_dt = datetime.utcnow()
        start_dt = end_dt - delta

        dataset, stype_in = resolve_databento_symbol(symbol)
        loop = asyncio.get_running_loop()

        def _fetch():
            try:
                client = db.Historical(self.api_key)
                data = client.timeseries.get_range(
                    dataset=dataset,
                    start=start_dt.isoformat(),
                    end=end_dt.isoformat(),
                    symbols=symbol,
                    stype_in=stype_in,
                    schema="tbbo",
                )
                return list(data)
            except Exception as exc:
                log.warning("Databento history fetch failed for %s: %s", symbol, exc)
                return []

        records = await loop.run_in_executor(None, _fetch)
        out: list[dict] = []
        for rec in records:
            if type(rec).__name__ == "SymbolMappingMsg":
                continue

            ts_event = getattr(rec, "ts_event", None)
            price = getattr(rec, "price", None)
            size = getattr(rec, "size", None)
            if ts_event is None or price is None or size is None or price == UNDEF_PRICE:
                continue

            price_val = float(price) * 1e-9
            vol_val = float(size)
            ts_ms = int(ts_event // 1_000_000)

            bid_val = None
            ask_val = None
            levels = getattr(rec, "levels", None)
            if levels and len(levels) > 0:
                bid_px = getattr(levels[0], "bid_px", None)
                ask_px = getattr(levels[0], "ask_px", None)
                if bid_px is not None and bid_px != UNDEF_PRICE:
                    bid_val = float(bid_px) * 1e-9
                if ask_px is not None and ask_px != UNDEF_PRICE:
                    ask_val = float(ask_px) * 1e-9

            out.append({
                "symbol": symbol.upper(),
                "timestamp": ts_ms,
                "price": price_val,
                "volume": vol_val,
                "bid": bid_val,
                "ask": ask_val,
            })
        return out
