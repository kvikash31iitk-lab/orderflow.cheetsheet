"""Safe, flag-driven footprint reaggregation (upsert-in-place by default).

Rebuilds footprint candles from the stored `ticks` table using the CURRENT aggregator
(so the latest CME/NSE session CVD/VWAP reset logic is applied) and writes them back via
save_candle's UPSERT — WITHOUT deleting existing rows first. Because save_candle UPSERTs
on (symbol, timeframe, start_time, row_size), each rebuilt candle overwrites its existing
row in place, so the chart never shows a transient "deleted history" gap (unlike
reaggregate_databento.py / reaggregate.py which DELETE-then-rebuild).

Quick start
-----------
  # 1) Dry run — writes NOTHING; prints tick/footprint coverage + candle counts:
  python reaggregate_safe.py --dry-run

  # 2) Safe in-place rebuild (DEFAULT, no delete, no gap) for GC/6E all timeframes:
  python reaggregate_safe.py

  # 3) Restrict scope:
  python reaggregate_safe.py --symbols GC.V.0 --timeframes 2m,5m,1h --from 2026-06-10

  # 4) Destructive delete-first (rarely needed) — requires coverage + explicit --yes:
  python reaggregate_safe.py --delete-first --yes      # BACK UP THE DB FIRST

Flags
-----
  --symbols        comma list (default: GC.V.0,6E.V.0)
  --timeframes     comma list (default: 1m,2m,3m,5m,15m,30m,1h,4h,1D)
  --from / --to    optional bounds: "YYYY-MM-DD" (UTC) or raw epoch-ms
  --dry-run        rebuild + count but DO NOT write
  --skip-heavy-tf  comma list of timeframes to skip the costly numpy detectors on
                   (default: 4h,1D) — preserves OHLC/delta/cumDelta/VWAP/session reset,
                   only drops volume-node + percentile signal detectors (large-TF cost guard)
  --delete-first   DESTRUCTIVE: delete each symbol's derived rows before rebuilding.
                   Requires --yes AND verified tick coverage of the footprint range.
  --yes            confirm a destructive --delete-first run

Verification queries after a run (psql):
  SELECT symbol,count(*) FROM footprints WHERE symbol IN ('GC.V.0','6E.V.0') GROUP BY 1;
  -- CVD should reset at the CME session open (17:00 America/Chicago):
  SELECT to_char(to_timestamp(start_time/1000) AT TIME ZONE 'America/Chicago','MM-DD HH24:MI'),
         delta, cum_delta FROM footprints
   WHERE symbol='GC.V.0' AND timeframe='1m' ORDER BY start_time;
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime, timezone

from app.config import TIMEFRAME_MINUTES, settings
from app.market_data.aggregator import Aggregator
from app.orderflow.models import Tick, TradeSide
from app.storage.postgres import PostgresRepo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reaggregate_safe")

DEFAULT_SYMBOLS = ["GC.V.0", "6E.V.0"]
DEFAULT_TIMEFRAMES = ["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"]
# derived tables a --delete-first run clears per symbol (skipped if no `symbol` column)
DERIVED_TABLES = [
    "footprints", "absorption", "exhaustion", "lp_signals",
    "ad_signals", "imbalances", "delta", "cum_delta",
]


def _parse_bound(s: str | None) -> int | None:
    """'YYYY-MM-DD' (UTC midnight) or raw epoch-ms -> epoch ms."""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _csv(s: str) -> list[str]:
    return [x.strip() for x in s.split(",") if x.strip()]


def _fmt(ms: int | None) -> str:
    if ms is None:
        return "—"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


async def _coverage(con, symbols: list[str]) -> dict[str, dict]:
    """Per-symbol tick vs footprint min/max + counts (for the coverage gate + report)."""
    out: dict[str, dict] = {}
    for sym in symbols:
        t = await con.fetchrow(
            "SELECT count(*) n, min(ts) lo, max(ts) hi FROM ticks WHERE symbol=$1", sym)
        f = await con.fetchrow(
            "SELECT count(*) n, min(start_time) lo, max(start_time) hi FROM footprints WHERE symbol=$1", sym)
        out[sym] = {
            "ticks": dict(t) if t else {"n": 0, "lo": None, "hi": None},
            "footprints": dict(f) if f else {"n": 0, "lo": None, "hi": None},
        }
    return out


def _covers(cov: dict) -> bool:
    """True if the symbol's ticks span at least its footprint range (delete-first safety)."""
    t, f = cov["ticks"], cov["footprints"]
    if not f["n"]:
        return True  # nothing to lose
    if not t["n"]:
        return False
    return t["lo"] is not None and t["hi"] is not None and t["lo"] <= f["lo"] and t["hi"] >= f["hi"]


async def main(args: argparse.Namespace) -> None:
    symbols = _csv(args.symbols)
    timeframes = [tf for tf in _csv(args.timeframes) if tf in TIMEFRAME_MINUTES]
    skip_heavy_tfs = set(_csv(args.skip_heavy_tf))
    lo, hi = _parse_bound(getattr(args, "from")), _parse_bound(args.to)

    repo = PostgresRepo(settings)
    await repo.connect()
    if not repo.enabled:
        log.error("Could not connect to database")
        return

    mode = "DRY-RUN" if args.dry_run else ("DELETE-FIRST" if args.delete_first else "UPSERT-IN-PLACE")
    log.info("mode=%s symbols=%s timeframes=%s skip_heavy=%s from=%s to=%s",
             mode, symbols, timeframes, sorted(skip_heavy_tfs), _fmt(lo), _fmt(hi))

    # ---- coverage report + delete-first safety gate ----
    async with repo.pool.acquire() as con:
        cov = await _coverage(con, symbols)
    for sym in symbols:
        c = cov[sym]
        log.info("  %-8s ticks=%d [%s .. %s] | footprints=%d [%s .. %s] | covers=%s",
                 sym, c["ticks"]["n"], _fmt(c["ticks"]["lo"]), _fmt(c["ticks"]["hi"]),
                 c["footprints"]["n"], _fmt(c["footprints"]["lo"]), _fmt(c["footprints"]["hi"]),
                 _covers(c))

    if args.delete_first:
        if not args.yes:
            log.error("--delete-first is DESTRUCTIVE; re-run with --yes to confirm (back up the DB first).")
            await repo.close()
            return
        uncovered = [s for s in symbols if not _covers(cov[s])]
        if uncovered:
            log.error("ABORT: ticks do NOT cover the footprint range for %s; "
                      "delete-first would lose history. Use the default upsert mode instead.", uncovered)
            await repo.close()
            return
        if not args.dry_run:
            log.warning("DELETING derived rows for %s ...", symbols)
            async with repo.pool.acquire() as con:
                for t in DERIVED_TABLES:
                    try:
                        res = await con.execute(f"DELETE FROM {t} WHERE symbol = ANY($1::text[])", symbols)
                        log.info("  %-12s %s", t, res)
                    except Exception as e:  # noqa: BLE001 - table may lack a symbol column
                        log.warning("  skip %-12s (%s)", t, e)

    # ---- load ticks (optionally bounded) ----
    where = ["symbol = ANY($1::text[])"]
    params: list = [symbols]
    if lo is not None:
        params.append(lo); where.append(f"ts >= ${len(params)}")
    if hi is not None:
        params.append(hi); where.append(f"ts <= ${len(params)}")
    sql = f"SELECT symbol, ts, price, volume, bid, ask, side FROM ticks WHERE {' AND '.join(where)} ORDER BY ts"
    async with repo.pool.acquire() as con:
        rows = await con.fetch(sql, *params)
    log.info("Loaded %d ticks.", len(rows))

    by_symbol: dict[str, list] = {}
    for r in rows:
        by_symbol.setdefault(r["symbol"], []).append(r)

    total_built = total_written = 0
    for sym in symbols:
        srows = by_symbol.get(sym, [])
        ticks = [
            Tick(symbol=r["symbol"], timestamp=r["ts"], price=r["price"], volume=r["volume"],
                 bid=r["bid"], ask=r["ask"], side=TradeSide(r["side"]))
            for r in srows
        ]
        log.info("%s: %d ticks", sym, len(ticks))
        for tf in timeframes:
            skip = tf in skip_heavy_tfs
            agg = Aggregator(sym, tf, cfg=settings, skip_heavy=skip)
            built = written = 0
            for tick in ticks:
                ev = agg.add_tick(tick)
                if ev.closed is not None:
                    built += 1
                    if not args.dry_run:
                        await repo.save_candle(ev.closed)
                        written += 1
            if agg.current is not None:
                live = agg.engine.analyze(agg.current, commit=False)
                built += 1
                if not args.dry_run:
                    await repo.save_candle(live)
                    written += 1
            total_built += built
            total_written += written
            log.info("  %s %-4s -> built=%d written=%d%s", sym, tf, built, written,
                     " (skip-heavy)" if skip else "")

    await repo.close()
    if args.dry_run:
        log.info("DRY-RUN complete. Would write %d candles. Nothing was changed.", total_built)
    else:
        log.info("Reaggregation complete (%s). candles written=%d", mode, total_written)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Safe footprint reaggregation (upsert-in-place by default).")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--timeframes", default=",".join(DEFAULT_TIMEFRAMES))
    p.add_argument("--from", dest="from", default=None, help="lower bound (YYYY-MM-DD or epoch-ms)")
    p.add_argument("--to", default=None, help="upper bound (YYYY-MM-DD or epoch-ms)")
    p.add_argument("--dry-run", action="store_true", help="rebuild + count but write nothing")
    p.add_argument("--skip-heavy-tf", default="4h,1D", help="timeframes to skip costly detectors on")
    p.add_argument("--delete-first", action="store_true", help="DESTRUCTIVE: delete before rebuild")
    p.add_argument("--yes", action="store_true", help="confirm a destructive --delete-first run")
    return p


if __name__ == "__main__":
    asyncio.run(main(_build_parser().parse_args()))
