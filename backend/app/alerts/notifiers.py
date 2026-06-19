"""Outbound alert channels: Telegram, Discord, WhatsApp webhook.

Popup + sound are handled client-side (the alert is broadcast over the frontend
WebSocket). All HTTP fan-out is fire-and-forget and never raises into the engine.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from ..config import Settings, settings as default_settings

log = logging.getLogger("alerts.notifier")


class Notifier:
    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or default_settings
        self._client = httpx.AsyncClient(timeout=5.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def dispatch(self, alert: dict) -> None:
        text = self._format(alert)
        if self.cfg.telegram_bot_token and self.cfg.telegram_chat_id:
            await self._telegram(text)
        if self.cfg.discord_webhook_url:
            await self._discord(text)
        if self.cfg.whatsapp_webhook_url:
            await self._whatsapp(alert, text)

    @staticmethod
    def _format(a: dict) -> str:
        return (
            f"🔔 {a['type']} | {a['symbol']} {a.get('timeframe', '')}\n"
            f"{a['message']}"
        )

    async def _telegram(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.cfg.telegram_bot_token}/sendMessage"
        await self._post(url, {"chat_id": self.cfg.telegram_chat_id, "text": text})

    async def _discord(self, text: str) -> None:
        await self._post(self.cfg.discord_webhook_url, {"content": text})

    async def _whatsapp(self, alert: dict, text: str) -> None:
        # Generic webhook contract; adapt to your WhatsApp Cloud API / gateway payload.
        await self._post(self.cfg.whatsapp_webhook_url, {"message": text, "alert": alert})

    async def _post(self, url: str, payload: dict) -> None:
        try:
            await self._client.post(url, json=payload)
        except Exception as exc:  # pragma: no cover - never break ingest
            log.debug("notifier post failed (%s): %s", url, exc)
