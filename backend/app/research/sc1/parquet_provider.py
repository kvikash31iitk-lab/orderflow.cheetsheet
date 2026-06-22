"""Research-only HISTORICAL data provider — serves SC1-compatible candle/tick dicts straight
from the normalized **GC.V.0 Parquet** dataset (the 5-year DataBento export), so SC1 research
can run on full history WITHOUT importing anything into the live `footprints` Postgres table.

Design: it duck-types the *exact* three async methods `large.py` calls on the Postgres
provider — `footprints_minmax`, `footprints_range`, `recent_ticks` — and returns the *same*
dict shapes as `postgres._rows_to_range_dicts` / `recent_ticks`. So it drops into
`start_large_job` / `start_walkforward_job` unchanged; the only wiring is choosing which
provider object to pass (`source="historical_parquet"` vs `"live_postgres"`).

Engine: **pyarrow.dataset** (lazy scan + predicate pushdown + column projection). pyarrow is
already a backend dependency (parquet tick recorder); polars (the other declared option) does
not import on this Python build, so pyarrow is the portable choice. All file I/O is wrapped in
`asyncio.to_thread`, exactly like the Postgres provider, so the live WS / footprint feed is
never blocked. **Read-only**: it never writes, moves, or deletes the dataset.

Expected layout under `SC1_RESEARCH_DATA_DIR` (default `<backend>/research_data/gc`):

    ticks/    bars_1m/    bars_5s/      each .../symbol=GC.V.0/year=YYYY/month=MM/*.parquet

`2m`/`3m` are AGGREGATED deterministically from `1m` on demand (no separate files). If the data
dir is absent (e.g. a VPS without the research copy yet), every method degrades gracefully
(`minmax`→None, `range`/`ticks`→[]), so enabling the source can never break production.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import os
import re
from typing import Optional

# snake_case (Parquet) -> camelCase (SC1 wire candle dict). Matches postgres._rows_to_range_dicts,
# PLUS maxDelta/minDelta which the live footprints table does not store but the V4 engine can use.
_BAR_PROJECT = ["start_time", "end_time", "row_size", "open", "high", "low", "close",
                "total_volume", "bid_volume", "ask_volume", "delta", "cum_delta", "poc",
                "max_delta", "min_delta", "tick_count", "active_contract"]
_TICK_PROJECT = ["symbol", "ts", "price", "volume", "bid", "ask", "side"]


def default_data_root() -> str:
    """`SC1_RESEARCH_DATA_DIR` env, else `<backend>/research_data/gc` (research path, NOT the
    live app data dir). On the VPS set e.g. `/root/orderflow_research_data/gc`."""
    env = os.environ.get("SC1_RESEARCH_DATA_DIR")
    if env:
        return env
    backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    return os.path.join(backend, "research_data", "gc")


def _tf_minutes(tf: str) -> Optional[int]:
    m = re.fullmatch(r"(\d+)\s*m", (tf or "").strip().lower())
    return int(m.group(1)) if m else None


def _day(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    return _dt.datetime.fromtimestamp(int(ms) / 1000, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


# --- shared-VPS guardrail: bound the span a single historical research request may scan -------
def max_research_days() -> int:
    """Max span (days) a historical_parquet job may request. Env `SC1_RESEARCH_MAX_DAYS`
    (default 7). Kept configurable so limits can be raised once heavy research moves off-box."""
    try:
        v = int(os.environ.get("SC1_RESEARCH_MAX_DAYS", "7"))
        return v if v > 0 else 7
    except (TypeError, ValueError):
        return 7


def check_span_days(start_ms: Optional[int], end_ms: Optional[int]) -> None:
    """Raise ValueError if a historical request is unbounded or wider than the configured max.
    Fails BEFORE any Parquet scan, so an over-wide range can't trigger a huge read on the box."""
    md = max_research_days()
    if start_ms is None or end_ms is None:
        raise ValueError(f"historical_parquet requires an explicit start and end date "
                         f"(max {md} days per run; set SC1_RESEARCH_MAX_DAYS to change)")
    if int(end_ms) < int(start_ms):
        raise ValueError("end must be on/after start")
    days = (int(end_ms) - int(start_ms)) / 86_400_000
    if days > md:
        raise ValueError(f"requested window is {days:.1f} days, which exceeds the "
                         f"SC1_RESEARCH_MAX_DAYS limit of {md} days; narrow the date range "
                         f"(wide historical jobs are paused on the shared box)")


class HistoricalParquetProvider:
    """Postgres-shaped, read-only view over normalized GC.V.0 Parquet for SC1 research."""

    enabled = True            # mirrors the Pg provider attribute some callers check
    windowed_ticks = True     # signals large.py to fetch ticks with a BOUNDED [lo,hi] window
                              # (live Postgres has no such attr -> keeps its recent_ticks path)

    def __init__(self, root: Optional[str] = None):
        self.root = root or default_data_root()

    # ----------------------------------------------------------------- discovery
    def _dir(self, sub: str) -> str:
        return os.path.join(self.root, sub)

    def _has(self, sub: str) -> bool:
        d = self._dir(sub)
        if not os.path.isdir(d):
            return False
        for _r, _ds, fs in os.walk(d):
            if any(f.endswith(".parquet") for f in fs):
                return True
        return False

    def _dataset(self, sub: str):
        import pyarrow.dataset as ds
        return ds.dataset(self._dir(sub), format="parquet")  # recurses; `symbol` is a file column

    def _parquet_files(self, sub: str) -> list[str]:
        out = []
        for r, _ds, fs in os.walk(self._dir(sub)):
            out.extend(os.path.join(r, f) for f in fs if f.endswith(".parquet"))
        return sorted(out)

    def _footer_minmax(self, sub: str, col: str) -> tuple:
        """(min, max, total_rows) of `col` read from Parquet FOOTERS only — never materialises
        the column. Sums row-group min/max + num_rows per file; falls back to reading a single
        file's column (bounded memory) only if a file was written without statistics. This keeps
        coverage/minmax O(files) and ~MB regardless of the 109M-row tick table."""
        import pyarrow.parquet as pq
        lo = hi = None
        total = 0
        for f in self._parquet_files(sub):
            pf = pq.ParquetFile(f)
            md = pf.metadata
            total += md.num_rows
            try:
                ci = pf.schema_arrow.names.index(col)
            except ValueError:
                continue
            fmin = fmax = None
            for rg in range(md.num_row_groups):
                st = md.row_group(rg).column(ci).statistics
                if st is not None and st.has_min_max:
                    fmin = st.min if fmin is None else min(fmin, st.min)
                    fmax = st.max if fmax is None else max(fmax, st.max)
            if fmin is None and md.num_rows:                     # no stats -> read just this file's col
                import pyarrow.compute as pc
                c = pf.read(columns=[col]).column(0)
                if len(c):
                    fmin, fmax = pc.min(c).as_py(), pc.max(c).as_py()
            if fmin is not None:
                lo = fmin if lo is None else min(lo, fmin)
                hi = fmax if hi is None else max(hi, fmax)
        return lo, hi, total

    # ----------------------------------------------------------------- sync core (run OFF the loop)
    def _read_bars(self, sub: str, symbol: str, lo, hi, limit) -> list[dict]:
        import pyarrow.compute as pc
        d = self._dataset(sub)
        names = set(d.schema.names)
        flt = pc.field("symbol") == symbol
        if lo is not None:
            flt = flt & (pc.field("start_time") >= int(lo))
        if hi is not None:
            flt = flt & (pc.field("start_time") <= int(hi))
        cols = [c for c in _BAR_PROJECT if c in names]
        rows = d.to_table(columns=cols, filter=flt).to_pylist()
        rows.sort(key=lambda r: r["start_time"])
        if limit and len(rows) > int(limit):
            rows = rows[-int(limit):]              # keep MOST-RECENT (matches Pg DESC LIMIT semantics)
        return rows

    @staticmethod
    def _map_bar(r: dict, symbol: str, tf: str) -> dict:
        return {
            "symbol": symbol, "timeframe": tf,
            "startTime": int(r["start_time"]), "endTime": int(r["end_time"]),
            "rowSize": float(r["row_size"]),
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "totalVolume": r["total_volume"], "totalBidVolume": r["bid_volume"],
            "totalAskVolume": r["ask_volume"], "delta": r["delta"], "cumDelta": r["cum_delta"],
            "poc": r.get("poc"), "maxDelta": r.get("max_delta"), "minDelta": r.get("min_delta"),
            "closed": True,
        }

    @staticmethod
    def _aggregate(one_min: list[dict], factor: int, symbol: str, tf: str) -> list[dict]:
        """Deterministic 1m -> N-minute aggregation (N=factor), aligned to absolute epoch buckets.
        OHLC merged correctly; volume/ask/bid/delta summed; cumDelta = final child value in the
        window; maxDelta/minDelta = max/min of child running peaks; poc = poc of the highest-volume
        child (true POC needs the per-price ladder which scalar bars don't carry — flagged)."""
        pm = factor * 60_000
        buckets: dict[int, dict] = {}
        order: list[int] = []
        for b in one_min:
            k = (int(b["startTime"]) // pm) * pm
            g = buckets.get(k)
            if g is None:
                g = {"symbol": symbol, "timeframe": tf, "startTime": k, "endTime": k + pm,
                     "rowSize": b["rowSize"], "open": b["open"], "high": b["high"],
                     "low": b["low"], "close": b["close"], "totalVolume": 0.0, "totalAskVolume": 0.0,
                     "totalBidVolume": 0.0, "delta": 0.0, "cumDelta": b["cumDelta"], "poc": b.get("poc"),
                     "maxDelta": None, "minDelta": None, "closed": True, "_pv": -1.0}
                buckets[k] = g
                order.append(k)
            g["high"] = max(g["high"], b["high"])
            g["low"] = min(g["low"], b["low"])
            g["close"] = b["close"]
            g["totalVolume"] += b["totalVolume"] or 0.0
            g["totalAskVolume"] += b["totalAskVolume"] or 0.0
            g["totalBidVolume"] += b["totalBidVolume"] or 0.0
            g["delta"] += b["delta"] or 0.0
            g["cumDelta"] = b["cumDelta"]                          # final running CVD in the window
            md, mn = b.get("maxDelta"), b.get("minDelta")
            if md is not None:
                g["maxDelta"] = md if g["maxDelta"] is None else max(g["maxDelta"], md)
            if mn is not None:
                g["minDelta"] = mn if g["minDelta"] is None else min(g["minDelta"], mn)
            v = b["totalVolume"] or 0.0
            if v > g["_pv"]:
                g["_pv"] = v
                g["poc"] = b.get("poc")                            # poc of the most-active child
        out = []
        for k in order:
            g = buckets[k]
            g.pop("_pv", None)
            out.append(g)
        return out

    def _range_sync(self, symbol: str, timeframe: str, lo, hi, limit) -> list[dict]:
        mins = _tf_minutes(timeframe)
        if timeframe.strip().lower() in ("5s", "5sec") and self._has("bars_5s"):
            return [self._map_bar(r, symbol, "5s") for r in self._read_bars("bars_5s", symbol, lo, hi, limit)]
        if mins == 1 and self._has("bars_1m"):
            return [self._map_bar(r, symbol, "1m") for r in self._read_bars("bars_1m", symbol, lo, hi, limit)]
        if mins and mins >= 2 and self._has("bars_1m"):
            child_cap = (int(limit) * mins) if limit else None
            one = [self._map_bar(r, symbol, "1m") for r in self._read_bars("bars_1m", symbol, lo, hi, child_cap)]
            agg = self._aggregate(one, mins, symbol, timeframe)
            if limit and len(agg) > int(limit):
                agg = agg[-int(limit):]
            return agg
        return []

    def _minmax_sync(self, symbol: str, timeframe: str) -> Optional[dict]:
        sub = "bars_5s" if timeframe.strip().lower() in ("5s", "5sec") else "bars_1m"
        if not self._has(sub):
            return None
        lo, hi, n = self._footer_minmax(sub, "start_time")       # footer stats only — low memory
        if not n or lo is None:
            return None
        mins = _tf_minutes(timeframe)
        if mins and mins >= 2:                                   # parent grid: align lo, approx count
            pm = mins * 60_000
            lo = (int(lo) // pm) * pm
            n = n // mins
        return {"minStart": int(lo), "maxStart": int(hi), "count": int(n)}

    def _ticks_sync(self, symbol: str, since_ms: int, limit: int) -> list[dict]:
        """Most-recent `limit` ticks at/after since_ms, scanning month files NEWEST-first with an
        early stop. Crucially this NEVER materialises the whole [since, end] span — for an old
        `since` that would be tens of millions of rows (an OOM risk on the shared box). One month
        file (<=~2M rows) is read at a time and we stop once `limit` is reached. The SC1 job path
        uses the explicitly windowed ticks_range(); this stays bounded purely as a safety net."""
        import pyarrow as pa
        import pyarrow.compute as pc
        import pyarrow.parquet as pq
        since = int(since_ms)
        cap = int(limit) if limit else None
        chunks, got = [], 0
        for f in sorted(self._parquet_files("ticks"), reverse=True):   # newest month first
            pf = pq.ParquetFile(f)
            names = pf.schema_arrow.names
            if "ts" in names:                                          # footer skip whole-older files
                ci = names.index("ts")
                fmax = None
                for rg in range(pf.metadata.num_row_groups):
                    st = pf.metadata.row_group(rg).column(ci).statistics
                    if st is not None and st.has_min_max:
                        fmax = st.max if fmax is None else max(fmax, st.max)
                if fmax is not None and fmax < since:
                    break                                             # newest-first: nothing older qualifies
            tb = pf.read(columns=[c for c in _TICK_PROJECT if c in names])
            flt = pc.field("ts") >= since if "ts" in names else None
            if "symbol" in names:
                flt = (pc.field("symbol") == symbol) if flt is None else (flt & (pc.field("symbol") == symbol))
            if flt is not None:
                tb = tb.filter(flt)
            if tb.num_rows:
                chunks.append(tb)
                got += tb.num_rows
            if cap and got >= cap:
                break
        if not chunks:
            return []
        rows = pa.concat_tables(chunks).to_pylist()
        rows.sort(key=lambda r: r["ts"])
        if cap and len(rows) > cap:
            rows = rows[-cap:]
        return rows

    def _ticks_range_sync(self, symbol: str, start_ms, end_ms, limit) -> list[dict]:
        import pyarrow.compute as pc
        if not self._has("ticks"):
            return []
        d = self._dataset("ticks")
        cols = [c for c in _TICK_PROJECT if c in set(d.schema.names)]
        flt = pc.field("symbol") == symbol
        if start_ms is not None:
            flt = flt & (pc.field("ts") >= int(start_ms))
        if end_ms is not None:
            flt = flt & (pc.field("ts") <= int(end_ms))         # BOTH bounds -> predicate pushdown
        rows = d.to_table(columns=cols, filter=flt).to_pylist()  # only matching row-groups are read
        rows.sort(key=lambda r: r["ts"])
        if limit and len(rows) > int(limit):
            rows = rows[-int(limit):]                            # keep most-recent WITHIN the window
        return rows

    def _coverage_sync(self, symbol: str) -> dict:
        out = {"symbol": symbol, "source": "historical_parquet", "dataRoot": self.root,
               "available": False, "ticks": None, "timeframes": [], "derivedTimeframes": [], "notes": []}
        if not os.path.isdir(self.root):
            out["notes"].append(f"research data dir not found: {self.root} — set SC1_RESEARCH_DATA_DIR")
            return out
        if self._has("ticks"):
            lo, hi, n = self._footer_minmax("ticks", "ts")       # footer stats only — NOT the 109M-row column
            if n and lo is not None:
                out["ticks"] = {"minTs": int(lo), "maxTs": int(hi), "count": int(n),
                                "fromDay": _day(lo), "toDay": _day(hi)}
        for tf in ("1m", "5s"):
            mm = self._minmax_sync(symbol, tf)
            if mm:
                out["available"] = True
                out["timeframes"].append({"timeframe": tf, **mm,
                                          "fromDay": _day(mm["minStart"]), "toDay": _day(mm["maxStart"])})
        if any(t["timeframe"] == "1m" for t in out["timeframes"]):
            out["derivedTimeframes"] = ["2m", "3m"]
        if not out["available"]:
            out["notes"].append(f"no '{symbol}' bars found under {self.root}")
        return out

    # ----------------------------------------------------------------- async API (Pg-shaped)
    async def footprints_minmax(self, symbol: str, timeframe: str, row_size: Optional[float] = None) -> Optional[dict]:
        return await asyncio.to_thread(self._minmax_sync, symbol.upper(), timeframe)

    async def footprints_range(self, symbol: str, timeframe: str, start_ms, end_ms,
                               row_size: Optional[float] = None, limit: int = 2_000_000) -> list[dict]:
        return await asyncio.to_thread(self._range_sync, symbol.upper(), timeframe, start_ms, end_ms, limit)

    async def recent_ticks(self, symbol: str, since_ms: int, limit: int = 1_500_000) -> list[dict]:
        return await asyncio.to_thread(self._ticks_sync, symbol.upper(), since_ms, limit)

    async def ticks_range(self, symbol: str, start_ms, end_ms, limit: Optional[int] = None) -> list[dict]:
        """Ticks with ts in [start_ms, end_ms] (either bound optional), ascending — the bounded
        fetch SC1 historical 5s reconstruction uses so it never reaches outside the analysis
        window. Mirrors postgres.ticks_range's (symbol, start, end, limit) signature."""
        return await asyncio.to_thread(self._ticks_range_sync, symbol.upper(), start_ms, end_ms, limit)

    async def coverage(self, symbol: str) -> dict:
        return await asyncio.to_thread(self._coverage_sync, symbol.upper())


_SINGLETON: Optional[HistoricalParquetProvider] = None


def get_provider() -> HistoricalParquetProvider:
    """Process-wide singleton (cheap; just holds a path). Rebuilt only on restart."""
    global _SINGLETON
    if _SINGLETON is None:
        _SINGLETON = HistoricalParquetProvider()
    return _SINGLETON
