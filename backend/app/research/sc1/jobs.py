"""Bounded in-process job manager for long-running SC1 research (large-dataset runs and
walk-forward optimisation).

Why in-process (not Celery/Redis): the backend is a single container with a live in-memory
pipeline; adding a broker is more moving parts than this needs today. Instead:
  - ONE worker thread (max_workers=1) — research never runs concurrently with itself, so
    the transient memory of an engine pass is bounded and the shared box can't be overrun.
  - The thread does pure CPU on data ALREADY LOADED in the async context, so it never
    touches the event loop or the asyncpg pool — the live WS/footprint feed stays responsive.
  - Cooperative cancellation via a threading.Event the worker polls between windows/combos.
  - A small LRU job registry; finished jobs are evicted first, running jobs never evicted.

The public surface (create/submit/get/list/cancel + Job.to_public) is deliberately the same
shape a Redis/DB-backed manager would expose, so this can be swapped later without touching
the API or the workers.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import OrderedDict
from typing import Callable, Optional


class JobCancelled(Exception):
    """Raised by a worker (or surfaced by the runner) when a job is cancelled mid-flight."""


class Job:
    __slots__ = ("id", "type", "params", "status", "progress", "created_at", "started_at",
                 "finished_at", "error", "result", "drilldown", "_cancel")

    def __init__(self, jid: str, jtype: str, params: dict, created_at: float):
        self.id = jid
        self.type = jtype
        self.params = params                       # JSON-safe echo of the request
        self.status = "queued"                     # queued | running | done | failed | cancelled
        self.progress = {"phase": "queued", "current": 0, "total": 0, "message": ""}
        self.created_at = created_at
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.error: Optional[str] = None
        self.result: Optional[dict] = None         # the (small) summaries
        self.drilldown: dict = {"candidates": [], "trades": []}  # bounded samples for paging
        self._cancel = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancel(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    def set_progress(self, **kw) -> None:
        self.progress.update(kw)

    def to_public(self) -> dict:
        elapsed = None
        if self.started_at is not None:
            end = self.finished_at if self.finished_at is not None else time.time()
            elapsed = round(end - self.started_at, 2)
        return {
            "id": self.id, "type": self.type, "params": self.params, "status": self.status,
            "progress": self.progress, "error": self.error,
            "createdAt": int(self.created_at * 1000),
            "startedAt": int(self.started_at * 1000) if self.started_at else None,
            "finishedAt": int(self.finished_at * 1000) if self.finished_at else None,
            "elapsedSec": elapsed,
            "hasResult": self.result is not None,
            "counts": {"candidates": len(self.drilldown.get("candidates", [])),
                       "trades": len(self.drilldown.get("trades", []))},
        }


class JobManager:
    def __init__(self, max_jobs: int = 12):
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_jobs
        # lazily-created single worker thread pool (one research job at a time)
        from concurrent.futures import ThreadPoolExecutor
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sc1job")

    def create(self, jtype: str, params: dict) -> Job:
        job = Job(uuid.uuid4().hex[:12], jtype, params, time.time())
        with self._lock:
            self._jobs[job.id] = job
            self._jobs.move_to_end(job.id)
            self._evict_locked()
        return job

    def _evict_locked(self) -> None:
        while len(self._jobs) > self._max:
            victim = None
            for k, v in self._jobs.items():
                if v.status in ("done", "failed", "cancelled"):
                    victim = k
                    break
            if victim is None:
                break  # everything is queued/running — don't evict live work
            del self._jobs[victim]

    def submit(self, job: Job, worker: Callable[[Job], None]) -> None:
        """Run `worker(job)` on the single background thread. Status/timestamps/errors are
        managed here so workers only do the work + update progress + poll job.check_cancel()."""
        def runner() -> None:
            job.status = "running"
            job.started_at = time.time()
            try:
                job.check_cancel()
                worker(job)
                job.status = "cancelled" if job.cancelled else "done"
            except JobCancelled:
                job.status = "cancelled"
            except Exception as e:  # a failed job must NEVER crash the worker thread/process
                job.status = "failed"
                job.error = f"{type(e).__name__}: {e}"
                traceback.print_exc()
            finally:
                job.finished_at = time.time()
        self._executor.submit(runner)

    def has_active(self) -> bool:
        """True if any job is queued or running. The single worker thread means a second job
        would only queue — but its dataset would be pinned in memory meanwhile, so callers
        refuse to even LOAD a second dataset while one is active (OOM guard on the tight box)."""
        with self._lock:
            return any(j.status in ("queued", "running") for j in self._jobs.values())

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        return [j.to_public() for j in reversed(jobs)][:limit]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job and job.status in ("queued", "running"):
            job._cancel.set()
            return True
        return False


# process-wide singleton (the API reaches it via this module)
MANAGER = JobManager()
