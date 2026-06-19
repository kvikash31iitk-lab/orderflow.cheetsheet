"""Live/replay WebSocket feed isolation + replay->live exit signalling."""
import json
from types import SimpleNamespace

from app.api.websocket import ConnectionManager
from app.config import settings
from app.replay.replay_engine import ReplayEngine


class _FakeWS:
    def __init__(self):
        self.sent: list[str] = []

    async def accept(self):
        pass

    async def send_text(self, s):
        self.sent.append(s)


class _RecordingConnections:
    """Captures broadcast() calls (used to assert which feed a frame targets)."""

    def __init__(self):
        self.broadcasts: list[dict] = []

    async def broadcast(self, message, symbol=None, timeframe=None, replay=False):
        self.broadcasts.append(
            {"message": message, "symbol": symbol, "timeframe": timeframe, "replay": replay}
        )


class _FakePG:
    async def ticks_range(self, symbol, start, end, limit=500_000):
        return []

    async def insert_ticks(self, rows):
        pass


# ----------------------------- WS feed isolation -----------------------------
async def test_ws_broadcast_isolates_live_and_replay():
    mgr = ConnectionManager()
    live_ws, rep_ws = _FakeWS(), _FakeWS()
    live_cid = await mgr.connect(live_ws)
    rep_cid = await mgr.connect(rep_ws)
    mgr.set_filter(live_cid, "NIFTY-I", "2m", replay=False)
    mgr.set_filter(rep_cid, "NIFTY-I", "2m", replay=True)

    await mgr.broadcast({"type": "candle", "data": {"x": 1}}, symbol="NIFTY-I", timeframe="2m", replay=False)
    assert len(live_ws.sent) == 1 and len(rep_ws.sent) == 0   # live frame -> live client only

    await mgr.broadcast({"type": "candle", "data": {"x": 2}}, symbol="NIFTY-I", timeframe="2m", replay=True)
    assert len(live_ws.sent) == 1 and len(rep_ws.sent) == 1   # replay frame -> replay client only

    assert json.loads(live_ws.sent[0])["data"]["x"] == 1      # no crosstalk
    assert json.loads(rep_ws.sent[0])["data"]["x"] == 2


async def test_ws_default_client_is_live_not_replay():
    mgr = ConnectionManager()
    ws = _FakeWS()
    await mgr.connect(ws)   # no set_filter -> default replay=False
    await mgr.broadcast({"type": "status"}, replay=False)
    assert len(ws.sent) == 1
    await mgr.broadcast({"type": "candle"}, replay=True)
    assert len(ws.sent) == 1   # replay broadcast must NOT reach a live client


async def test_ws_set_filter_stores_replay_flag():
    mgr = ConnectionManager()
    ws = _FakeWS()
    cid = await mgr.connect(ws)
    mgr.set_filter(cid, "X", "1m", replay=True)
    await mgr.broadcast({"type": "candle"}, replay=True)
    assert len(ws.sent) == 1


# --------------------------- replay -> live exit ---------------------------
async def test_replay_stop_broadcasts_exit_on_replay_feed():
    conn = _RecordingConnections()
    rep = ReplayEngine(pg=_FakePG(), connections=conn, cfg=settings, client=None)
    rep._symbol, rep._timeframe = "NIFTY-I", "2m"
    await rep.stop()
    assert len(conn.broadcasts) == 1
    b = conn.broadcasts[0]
    assert b["replay"] is True                       # exit goes on the replay feed
    assert b["message"]["type"] == "replay"
    d = b["message"]["data"]
    assert d["exit"] is True and d["playing"] is False and d["total"] == 0


async def test_replay_load_does_not_broadcast_exit():
    conn = _RecordingConnections()
    rep = ReplayEngine(pg=_FakePG(), connections=conn, cfg=settings, client=None)
    await rep.load("X", 0, 3_600_000, "1m")   # cleanup via _cancel, not stop
    assert all(not b["message"].get("data", {}).get("exit") for b in conn.broadcasts)


async def test_replay_emit_uses_replay_feed():
    conn = _RecordingConnections()
    rep = ReplayEngine(pg=_FakePG(), connections=conn, cfg=settings, client=None)
    rep._symbol, rep._timeframe = "NIFTY-I", "2m"
    ev = SimpleNamespace(live=SimpleNamespace(to_dict=lambda: {"symbol": "NIFTY-I", "timeframe": "2m"}))
    await rep._emit(ev)
    b = conn.broadcasts[0]
    assert b["replay"] is True and b["symbol"] == "NIFTY-I" and b["timeframe"] == "2m"
    assert b["message"]["data"]["replay"] is True
