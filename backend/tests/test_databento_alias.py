from app.config import Settings
from app.market_data.databento_client import ConnectionStatus, DatabentoClient, resolve_databento_symbol
from app.market_data.websocket_client import MarketDataClient


def test_status_clears_stale_reconnect_message_once_connected():
    """A stale 'No ticks recently…' warning must not surface while state==connected, but must
    still show while reconnecting, and a normal healthy message must be preserved."""
    s = ConnectionStatus(source="databento", last_tick_ms=1)
    s.state = "reconnecting"
    s.message = "No ticks recently; Databento reconnect in progress."
    assert s.to_dict()["message"].startswith("No ticks recently")   # shown while genuinely reconnecting
    s.state = "connected"
    assert s.to_dict()["message"] == ""                              # cleared once connected + fresh
    s.message = "Databento Live: 2 live, 0 simulated"
    assert s.to_dict()["message"] == "Databento Live: 2 live, 0 simulated"  # healthy msg preserved


async def _noop(_raw):
    return None


def test_databento_symbol_aliases_keep_public_gc_symbol_stable():
    cfg = Settings(
        truedata_symbols="",
        databento_symbols="6E.v.0,GCQ6",
        databento_symbol_aliases="GCQ6:GC.V.0",
    )

    assert cfg.databento_symbols_list == ["6E.V.0", "GCQ6"]
    assert cfg.databento_symbol_alias_map == {"GCQ6": "GC.V.0"}
    assert cfg.databento_display_symbols_list == ["6E.V.0", "GC.V.0"]
    assert cfg.symbols == ["6E.V.0", "GC.V.0"]


def test_databento_raw_gc_contract_uses_raw_symbol_stype():
    assert resolve_databento_symbol("GCQ6") == ("GLBX.MDP3", "raw_symbol")
    assert resolve_databento_symbol("6EN6") == ("GLBX.MDP3", "raw_symbol")
    assert resolve_databento_symbol("GC.v.0") == ("GLBX.MDP3", "continuous")


def test_databento_client_subscribes_raw_contract_but_reports_display_symbol():
    cfg = Settings(
        truedata_symbols="",
        databento_symbols="6E.v.0,GCQ6",
        databento_symbol_aliases="GCQ6=GC.V.0",
    )

    client = DatabentoClient(_noop, cfg=cfg)

    assert client.subscribe_symbols == ["6E.V.0", "GCQ6"]
    assert client.symbols == ["6E.V.0", "GC.V.0"]
    assert client.status.symbols == ["6E.V.0", "GC.V.0"]
    assert client._sub_to_display["GCQ6"] == "GC.V.0"
    assert client._display_to_sub["GC.V.0"] == "GCQ6"


async def test_market_data_history_routes_display_alias_to_databento():
    cfg = Settings(
        truedata_symbols="NIFTY-I",
        databento_symbols="6E.v.0,GCQ6",
        databento_symbol_aliases="GCQ6:GC.V.0",
    )
    client = MarketDataClient(_noop, cfg=cfg)
    calls = []

    async def _db_history(symbol, duration="1 D", bar_size="tick"):
        calls.append(("databento", symbol, duration, bar_size))
        return []

    async def _td_history(symbol, duration="1 D", bar_size="tick"):
        calls.append(("truedata", symbol, duration, bar_size))
        return []

    client.databento_client.get_history = _db_history
    client.truedata_client.get_history = _td_history

    await client.get_history("GC.V.0", "2 H", "tick")
    await client.get_history("NIFTY-I", "2 H", "tick")

    assert calls == [
        ("databento", "GC.V.0", "2 H", "tick"),
        ("truedata", "NIFTY-I", "2 H", "tick"),
    ]
