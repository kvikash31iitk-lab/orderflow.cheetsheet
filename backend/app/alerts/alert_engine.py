"""Turn closed-candle signals into deduplicated, fanned-out alerts."""
from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from ..config import Settings, settings as default_settings
from ..orderflow.models import FootprintCandle
from .notifiers import Notifier

log = logging.getLogger("alerts.engine")

# signal label -> (alert type, severity)
_SEVERITY = {
    "ABSORPTION": ("Absorption", "warning"),
    "EXHAUSTION": ("Exhaustion", "warning"),
    "LP": ("Liquidity Provider", "high"),
    "AD": ("Aggressive Delta", "high"),
    "STACKED_IMBALANCE": ("Stacked Imbalance", "high"),
    "DELTA_SPIKE": ("Delta Spike", "info"),
    "VOLUME_SPIKE": ("Volume Spike", "info"),
    "HVN": ("High Volume Node", "info"),
    "LVN": ("Low Volume Node", "info"),
}


@dataclass
class Alert:
    ts: int
    symbol: str
    timeframe: str
    type: str
    severity: str
    message: str
    payload: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "ts": self.ts, "symbol": self.symbol, "timeframe": self.timeframe,
            "type": self.type, "severity": self.severity, "message": self.message,
            "payload": self.payload,
        }


class AlertEngine:
    def __init__(
        self,
        notifier: Optional[Notifier] = None,
        on_alert: Optional[Callable[[Alert], Awaitable[None]]] = None,
        persist: Optional[Callable[[dict], Awaitable[None]]] = None,
        cfg: Optional[Settings] = None,
    ) -> None:
        self.cfg = cfg or default_settings
        self.notifier = notifier or Notifier(cfg)
        self.on_alert = on_alert          # broadcast to frontend (popup/sound)
        self.persist = persist            # write to postgres
        self.recent: deque[Alert] = deque(maxlen=200)
        self._seen: set[tuple] = set()    # dedupe (symbol, tf, start_time, label)

    async def evaluate(self, candle: FootprintCandle) -> list[Alert]:
        if not self.cfg.alerts_enabled:
            return []
        fired: list[Alert] = []
        for label in candle.signals.active_labels():
            key = (candle.symbol, candle.timeframe, candle.start_time, label)
            if key in self._seen:
                continue
            self._seen.add(key)
            fired.append(self._build(candle, label))
        for a in fired:
            await self._dispatch(a)
        # keep dedupe set bounded
        if len(self._seen) > 5000:
            self._seen = set(list(self._seen)[-2500:])
        return fired

    def _build(self, c: FootprintCandle, label: str) -> Alert:
        atype, severity = _SEVERITY.get(label, (label.title(), "info"))
        msg = self._message(c, label)
        return Alert(
            ts=int(time.time() * 1000), symbol=c.symbol, timeframe=c.timeframe,
            type=atype, severity=severity, message=msg,
            payload={
                "label": label, "startTime": c.start_time, "close": c.close,
                "delta": c.delta, "cumDelta": c.cum_delta,
            },
        )

    @staticmethod
    def _message(c: FootprintCandle, label: str) -> str:
        s = c.signals
        if label == "LP":
            return f"LP {s.lp_side} @ {s.lp_price} (vol {c.total_volume:.0f}, body small)"
        if label == "ABSORPTION":
            return f"Absorption on {s.absorption_side} @ {s.absorption_price} (Δ {c.delta:+.0f})"
        if label == "EXHAUSTION":
            return f"Exhaustion at {s.exhaustion_type} (Δ {c.delta:+.0f})"
        if label == "AD":
            return f"Aggressive delta {s.ad_value:+.0f} @ {c.close}"
        if label == "STACKED_IMBALANCE":
            zones = ", ".join(f"{z.direction} x{z.count}" for z in s.stacked_imbalances)
            return f"Stacked imbalance: {zones}"
        if label == "DELTA_SPIKE":
            return f"Delta spike {c.delta:+.0f} @ {c.close}"
        if label == "VOLUME_SPIKE":
            return f"Volume spike {c.total_volume:.0f} @ {c.close}"
        if label == "HVN":
            return f"High-volume node(s): {s.hvn}"
        if label == "LVN":
            return f"Low-volume node(s): {s.lvn}"
        return f"{label} @ {c.close}"

    async def _dispatch(self, a: Alert) -> None:
        self.recent.appendleft(a)
        if self.persist:
            try:
                await self.persist(a.to_dict())
            except Exception:  # pragma: no cover
                log.exception("alert persist failed")
        if self.on_alert:
            try:
                await self.on_alert(a)
            except Exception:  # pragma: no cover
                log.exception("alert broadcast failed")
        try:
            await self.notifier.dispatch(a.to_dict())
        except Exception:  # pragma: no cover
            log.exception("alert notify failed")
