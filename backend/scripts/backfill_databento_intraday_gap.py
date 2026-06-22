"""One-off, BOUNDED intraday DataBento gap backfill (idempotent).

Fills a specific [start,end] window for ONE symbol from the DataBento Historical API,
reusing the app's exact tick parsing (price x1e-9, tbbo bid/ask, vendor aggressor side ->
TickHandler) so the rows are identical to the live feed. Footprints are then rebuilt by the
existing `reaggregate_safe.py` (NOT a new candle builder) so CVD/VWAP session logic matches.

  source contract  ->  stored/display symbol      (GC: raw GCQ6 -> GC.V.0; 6E: 6E.V.0)

Modes
-----
  dry-sample : fetch a tiny window, PRINT validation (record count, price range, side mix,
               one rebuilt 2m candle) and write NOTHING. Use to confirm scaling/side/alias
               and to probe whether a symbol is genuinely missing data.
  backfill   : back up affected rows to --backup-dir, then DELETE-then-INSERT ticks bounded
               to EXACTLY [--start,--end] for --display only (idempotent; safe to re-run).
               Footprints are rebuilt separately via reaggregate_safe.py.

Examples
--------
  python backfill_databento_intraday_gap.py --mode dry-sample --src GCQ6 --display GC.V.0 \
      --start 2026-06-22T06:00:00Z --end 2026-06-22T06:05:00Z
  python backfill_databento_intraday_gap.py --mode backfill --src GCQ6 --display GC.V.0 \
      --start 2026-06-21T22:00:00Z --end 2026-06-22T13:10:00Z --backup-dir /root/backfill_backups

GUARDED OPERATIONAL UTILITY — manual one-off only (NOT an app runtime path)
---------------------------------------------------------------------------
This module is never imported or scheduled by the live app; it is hand-invoked for repairs.
Guards:
  * `--mode` DEFAULTS to `dry-sample` (writes nothing); mutation needs an EXPLICIT `--mode backfill`.
  * DELETE/INSERT is bounded to EXACTLY one `--display` symbol within [--start,--end] — it never
    truncates tables or touches any other symbol (TrueData symbols are never affected).
  * a row backup (ticks + footprints for the window) is MANDATORY and is verified non-empty
    BEFORE any mutation; if the backup is missing/empty the run aborts.
  * the DataBento API key is read from settings/env only — never hardcode or pass a secret.

Used in PRODUCTION on 2026-06-22 to repair the GC/6E intraday DataBento outage (GC.v.0 had
drifted to the stale GCM6 contract; 6E was live-under-captured). Exact invocations:
  GC: --mode backfill --src GCQ6   --display GC.V.0 --start 2026-06-21T22:00:00Z --end 2026-06-22T13:10:00Z
  6E: --mode backfill --src 6E.V.0 --display 6E.V.0 --start 2026-06-22T07:38:00Z --end 2026-06-22T13:20:00Z
then footprints/CVD were rebuilt with the existing aggregator via:
  reaggregate_safe.py --symbols <sym> --from <CME session-open ms> --timeframes 1m,2m,3m,5m,15m,30m,1h
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from collections import Counter
from datetime import datetime, timezone

from app.config import settings
from app.market_data.databento_client import UNDEF_PRICE, resolve_databento_symbol
from app.market_data.tick_handler import TickHandler
from app.orderflow.models import Tick, TradeSide
from app.storage.postgres import PostgresRepo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_gap")


def _iso_to_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def _ms_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _fetch(src: str, start_iso: str, end_iso: str) -> list:
    """Fetch tbbo records for `src` over [start,end] using the app's dataset/stype resolution."""
    import databento as db
    dataset, stype_in = resolve_databento_symbol(src.upper())
    log.info("fetch src=%s dataset=%s stype_in=%s schema=tbbo window=%s..%s",
             src, dataset, stype_in, start_iso, end_iso)
    client = db.Historical(settings.databento_api_key)
    data = client.timeseries.get_range(
        dataset=dataset, start=start_iso, end=end_iso, symbols=src.upper(),
        stype_in=stype_in, schema="tbbo")
    return list(data)


def _parse(records: list, display: str) -> tuple[list[Tick], dict]:
    """Map raw tbbo records -> normalized Tick list (exactly like the live feed)."""
    handler = TickHandler()
    mapped = []
    raw_side = Counter()
    for rec in records:
        if type(rec).__name__ == "SymbolMappingMsg":
            continue
        ts_event = getattr(rec, "ts_event", None)
        price = getattr(rec, "price", None)
        size = getattr(rec, "size", None)
        if ts_event is None or price is None or size is None or price == UNDEF_PRICE:
            continue
        price_val = float(price) * 1e-9
        ts_ms = int(ts_event // 1_000_000)
        bid_val = ask_val = None
        levels = getattr(rec, "levels", None)
        if levels:
            bid_px = getattr(levels[0], "bid_px", None)
            ask_px = getattr(levels[0], "ask_px", None)
            if bid_px is not None and bid_px != UNDEF_PRICE:
                bid_val = float(bid_px) * 1e-9
            if ask_px is not None and ask_px != UNDEF_PRICE:
                ask_val = float(ask_px) * 1e-9
        raw_side[str(getattr(rec, "side", None))] += 1
        mapped.append((ts_ms, price_val, float(size), bid_val, ask_val, getattr(rec, "side", None)))
    mapped.sort(key=lambda x: x[0])
    ticks = [handler.normalise(symbol=display, timestamp=m[0], price=m[1], volume=m[2],
                               bid=m[3], ask=m[4], side=m[5]) for m in mapped]
    stats = {
        "raw_records": len(records), "parsed_ticks": len(ticks), "raw_side": dict(raw_side),
        "side_mix": dict(Counter(t.side.value for t in ticks)),
    }
    if ticks:
        px = [t.price for t in ticks]
        stats.update({"price_min": min(px), "price_max": max(px), "price_last": px[-1],
                      "ts_first": _ms_iso(ticks[0].timestamp), "ts_last": _ms_iso(ticks[-1].timestamp)})
    return ticks, stats


def _sample_candle(ticks: list[Tick], display: str, tf: str) -> dict | None:
    """Rebuild candles with the live Aggregator and return the last closed one (shape check)."""
    from app.market_data.aggregator import Aggregator
    agg = Aggregator(display, tf, cfg=settings, skip_heavy=True)
    last = None
    for t in ticks:
        ev = agg.add_tick(t)
        if ev.closed is not None:
            last = ev.closed
    src = last if last is not None else (agg.engine.analyze(agg.current, commit=False) if agg.current else None)
    if src is None:
        return None
    return {k: getattr(src, k, None) for k in
            ("symbol", "timeframe", "start_time", "open", "high", "low", "close",
             "total_volume", "total_ask_volume", "total_bid_volume", "delta", "cum_delta", "poc", "row_size")}


async def _backup(repo: PostgresRepo, display: str, lo: int, hi: int, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = os.path.join(backup_dir, f"backup_{display.replace('.', '_')}_{stamp}.json")
    async with repo.pool.acquire() as con:
        ticks = await con.fetch("SELECT symbol,ts,price,volume,bid,ask,side FROM ticks "
                                "WHERE symbol=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts", display, lo, hi)
        fps = await con.fetch("SELECT symbol,timeframe,start_time,open,high,low,close,total_volume,"
                              "bid_volume,ask_volume,delta,cum_delta,poc,row_size FROM footprints "
                              "WHERE symbol=$1 AND start_time BETWEEN $2 AND $3 ORDER BY timeframe,start_time",
                              display, lo, hi)
    payload = {"symbol": display, "window_utc": [_ms_iso(lo), _ms_iso(hi)], "lo_ms": lo, "hi_ms": hi,
               "ticks": [dict(r) for r in ticks], "footprints": [dict(r) for r in fps]}
    with open(path, "w") as f:
        json.dump(payload, f, default=str)
    log.info("BACKUP %d ticks + %d footprints -> %s", len(ticks), len(fps), path)
    return path


async def main(a: argparse.Namespace) -> None:
    lo, hi = _iso_to_ms(a.start), _iso_to_ms(a.end)
    records = await asyncio.to_thread(_fetch, a.src, a.start, a.end)
    ticks, stats = _parse(records, a.display)
    log.info("PARSE %s", json.dumps(stats, default=str))
    cand = _sample_candle(ticks, a.display, a.tf)
    log.info("SAMPLE %s candle: %s", a.tf, json.dumps(cand, default=str) if cand else "none (no ticks)")

    if a.mode == "dry-sample":
        log.info("DRY-SAMPLE: wrote nothing. records=%d parsed=%d", stats["raw_records"], stats["parsed_ticks"])
        return

    if not ticks:
        log.warning("BACKFILL aborted: 0 parsed ticks for %s in window — nothing to insert.", a.display)
        return

    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("DB not connected"); return
    try:
        bpath = await _backup(repo, a.display, lo, hi, a.backup_dir)
        if not bpath or not os.path.exists(bpath) or os.path.getsize(bpath) == 0:
            log.error("MANDATORY BACKUP missing/empty (%s) — aborting BEFORE any mutation.", bpath)
            return
        rows = [(t.symbol, t.timestamp, t.price, t.volume, t.bid, t.ask, t.side.value) for t in ticks]
        async with repo.pool.acquire() as con:
            async with con.transaction():
                deleted = await con.execute("DELETE FROM ticks WHERE symbol=$1 AND ts BETWEEN $2 AND $3",
                                            a.display, lo, hi)
                for i in range(0, len(rows), 5000):
                    await con.executemany(
                        "INSERT INTO ticks (symbol, ts, price, volume, bid, ask, side) "
                        "VALUES ($1,$2,$3,$4,$5,$6,$7)", rows[i:i + 5000])
        log.info("BACKFILL done. deleted=%s inserted=%d window=%s..%s backup=%s",
                 deleted, len(rows), _ms_iso(lo), _ms_iso(hi), bpath)
        log.info("NEXT: rebuild footprints via reaggregate_safe.py "
                 "--symbols %s --from %d --to %d", a.display, lo, hi)
    finally:
        await repo.close()


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Bounded intraday DataBento gap backfill (idempotent).")
    p.add_argument("--mode", choices=["dry-sample", "backfill"], default="dry-sample",
                   help="dry-sample = DEFAULT, writes nothing; backfill = mutate (must be set EXPLICITLY)")
    p.add_argument("--src", required=True, help="DataBento source symbol (e.g. GCQ6, 6E.V.0, 6EU6)")
    p.add_argument("--display", required=True, help="stored/display symbol (e.g. GC.V.0, 6E.V.0)")
    p.add_argument("--start", required=True, help="ISO UTC, e.g. 2026-06-21T22:00:00Z")
    p.add_argument("--end", required=True, help="ISO UTC")
    p.add_argument("--tf", default="2m", help="timeframe for the sample candle (default 2m)")
    p.add_argument("--backup-dir", default="/root/backfill_backups")
    return p


if __name__ == "__main__":
    asyncio.run(main(_parser().parse_args()))
