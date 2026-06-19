"""Local tick recorder — appends every tick to per-symbol/day parquet files.

Buffered + flushed off the hot path. Parquet via pyarrow; if unavailable it
falls back to newline-delimited JSON so recording never silently stops.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Optional

from ..config import Settings, settings as default_settings

log = logging.getLogger("storage.recorder")

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    _HAVE_ARROW = True
except Exception:  # pragma: no cover
    _HAVE_ARROW = False


class TickRecorder:
    def __init__(self, cfg: Optional[Settings] = None, flush_every: int = 2000) -> None:
        self.cfg = cfg or default_settings
        self.dir = Path(self.cfg.tick_recording_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.flush_every = flush_every
        self._buf: list[dict] = []
        self._writer: Optional[pq.ParquetWriter] = None
        self._writer_path: Optional[Path] = None

    def add(self, tick: dict) -> None:
        self._buf.append(tick)
        if len(self._buf) >= self.flush_every:
            self.flush()

    def _path(self, ext: str) -> Path:
        day = time.strftime("%Y%m%d")
        return self.dir / f"ticks_{day}.{ext}"

    def flush(self) -> None:
        if not self._buf:
            return
        rows, self._buf = self._buf, []
        try:
            if _HAVE_ARROW:
                table = pa.Table.from_pylist(rows)
                path = self._path("parquet")
                if self._writer is None or self._writer_path != path:
                    if self._writer is not None:
                        try:
                            self._writer.close()
                        except Exception:
                            pass
                    if path.exists():
                        try:
                            existing = pq.read_table(path)
                            table = pa.concat_tables([existing, table])
                        except Exception:
                            pass
                    self._writer = pq.ParquetWriter(path, table.schema)
                    self._writer_path = path
                self._writer.write_table(table)
            else:
                with self._path("jsonl").open("a", encoding="utf-8") as fh:
                    for r in rows:
                        fh.write(json.dumps(r) + "\n")
        except Exception as exc:  # pragma: no cover
            log.warning("tick recording flush failed: %s", exc)

    def close(self) -> None:
        self.flush()
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:
                pass
            self._writer = None
            self._writer_path = None
