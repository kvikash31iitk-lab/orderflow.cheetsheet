"""FastAPI surface: live WebSocket stream + REST routes."""
from .websocket import ConnectionManager

__all__ = ["ConnectionManager"]
