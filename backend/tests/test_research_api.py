"""DB outcome-sync (MAE/MFE) job + research REST endpoints."""
from types import SimpleNamespace

import pytest

# These pull the storage/api stack; skip cleanly if those deps are absent.
pytest.importorskip("asyncpg")
pytest.importorskip("fastapi")

from app.config import settings
from app.orderflow.models import FootprintCandle, Signals
from app.storage.postgres import PostgresRepo


# ----------------------------- DB outcome sync -----------------------------
class _FakeRepo(PostgresRepo):
    """In-memory PostgresRepo: real sync_signal_outcomes over fake DB helpers."""

    def __init__(self, unvalidated, entries, closes):
        self.enabled = True
        self._unvalidated = unvalidated
        self._entries = entries
        self._closes = closes
        self.updates: list[dict] = []

    async def get_unvalidated_signals(self, table):
        return list(self._unvalidated.get(table, []))

    async def get_forward_closes(self, symbol, timeframe, start_time, limit):
        return list(self._closes.get((symbol, timeframe, start_time), []))[:limit]

    async def _entry_close(self, symbol, timeframe, start_time):
        return self._entries.get((symbol, timeframe, start_time))

    async def update_signal_outcome(self, table_name, signal_id, mae, mfe, outcome):
        self.updates.append({"table": table_name, "id": signal_id, "mae": mae, "mfe": mfe, "outcome": outcome})


async def test_sync_signal_outcomes_computes_mae_mfe():
    repo = _FakeRepo(
        unvalidated={
            "lp_signals": [{"id": 1, "symbol": "X", "timeframe": "1m", "start_time": 0, "side": "support", "price": 100.0}],
            "ad_signals": [{"id": 2, "symbol": "X", "timeframe": "1m", "start_time": 0, "delta_value": 500.0}],
        },
        entries={("X", "1m", 0): 100.0},
        closes={("X", "1m", 0): [101.0, 99.0, 103.0]},
    )
    n = await repo.sync_signal_outcomes(horizon=5)
    assert n == 2
    # entry 100, long (support / +delta), closes [101,99,103]: mfe=+3, mae=1, ret=+3 -> win
    lp = next(u for u in repo.updates if u["table"] == "lp_signals")
    assert lp["mfe"] == 3.0 and lp["mae"] == 1.0 and lp["outcome"] == "win"
    ad = next(u for u in repo.updates if u["table"] == "ad_signals")
    assert ad["mfe"] == 3.0 and ad["mae"] == 1.0 and ad["outcome"] == "win"


async def test_sync_short_side_and_loss_outcome():
    # AD with negative delta -> short. closes rise -> adverse -> loss.
    repo = _FakeRepo(
        unvalidated={"ad_signals": [{"id": 9, "symbol": "X", "timeframe": "1m", "start_time": 0, "delta_value": -500.0}], "lp_signals": []},
        entries={("X", "1m", 0): 100.0},
        closes={("X", "1m", 0): [101.0, 102.0]},
    )
    await repo.sync_signal_outcomes(horizon=5)
    u = repo.updates[0]
    # short from 100, price went to 102: ret = 100-102 = -2 -> loss; mae=2, mfe=0
    assert u["outcome"] == "loss" and u["mae"] == 2.0 and u["mfe"] == 0.0


async def test_sync_skips_signals_without_forward_data():
    repo = _FakeRepo(
        unvalidated={"ad_signals": [{"id": 3, "symbol": "X", "timeframe": "1m", "start_time": 0, "delta_value": 100.0}], "lp_signals": []},
        entries={("X", "1m", 0): 100.0},
        closes={},  # no forward candles yet
    )
    assert await repo.sync_signal_outcomes(horizon=5) == 0
    assert repo.updates == []


# ----------------------------- REST endpoints -----------------------------
def _candle_dict(start, close, ad=False, adv=0.0):
    c = FootprintCandle(symbol="X", timeframe="1m", start_time=start, end_time=start + 60000, row_size=1.0, close=close)
    if ad:
        c.signals = Signals(ad=True, ad_value=adv)
    return c.to_dict()


def _req(pg):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(pipeline=SimpleNamespace(pg=pg))))


async def test_research_validate_endpoint():
    from app.api.routes import ResearchValidate, research_validate

    rows = [
        _candle_dict(0, 100.0, ad=True, adv=500.0),
        _candle_dict(60000, 101.0),
        _candle_dict(120000, 102.0),
        _candle_dict(180000, 103.0),
    ]

    class _PG:
        async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
            assert symbol == "X" and timeframe == "1m"
            return rows

    out = await research_validate(_req(_PG()), ResearchValidate(symbol="x", timeframe="1m", kind="AD", horizon=5))
    assert out["n"] == 1 and out["winRate"] == 1.0 and out["avgMfe"] == 3.0


async def test_research_sweep_endpoint_returns_one_report_per_combo():
    from app.api.routes import ResearchSweep, research_sweep

    rows = [_candle_dict(0, 100.0), _candle_dict(60000, 101.0)]

    class _PG:
        async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
            return rows

    out = await research_sweep(
        _req(_PG()),
        ResearchSweep(symbol="X", timeframe="1m", kind="AD", horizon=5, grid={"ad_delta_percentile": [80, 90, 95]}),
    )
    assert "reports" in out and len(out["reports"]) == 3   # 3 grid values -> 3 reports


async def test_research_sync_endpoint():
    from app.api.routes import research_sync

    class _PG:
        async def sync_signal_outcomes(self, horizon):
            assert horizon == 5
            return 7

    out = await research_sync(_req(_PG()), horizon=5)
    assert out["updated"] == 7


async def test_research_validate_with_params_reanalyzes():
    # supplying threshold overrides must re-run the engine (the "Apply" path) and
    # still return a valid report — exercises from_dict cells + replay_with_settings.
    from app.api.routes import ResearchValidate, research_validate
    from app.orderflow.footprint import add_tick
    from app.orderflow.models import Tick, TradeSide

    def mk(start, base):
        c = FootprintCandle(symbol="X", timeframe="1m", start_time=start, end_time=start + 60000, row_size=1.0)
        add_tick(c, Tick("X", 1, base, 50, side=TradeSide.BUY))
        add_tick(c, Tick("X", 2, base, 30, side=TradeSide.SELL))
        return c.to_dict()

    rows = [mk(i * 60000, 100.0 + i) for i in range(8)]

    class _PG:
        async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
            return rows

    out = await research_validate(
        _req(_PG()),
        ResearchValidate(symbol="X", timeframe="1m", kind="AD", horizon=3, params={"ad_delta_percentile": 50}),
    )
    assert {"n", "winRate", "expectancy", "avgMae", "avgMfe"} <= set(out)


async def test_research_validate_unknown_param_raises_422():
    from fastapi import HTTPException

    from app.api.routes import ResearchValidate, research_validate

    class _PG:
        async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
            return []

    with pytest.raises(HTTPException) as ei:
        await research_validate(_req(_PG()), ResearchValidate(symbol="X", kind="AD", horizon=5, params={"not_a_field": 1.0}))
    assert ei.value.status_code == 422


async def test_research_sweep_unknown_grid_key_raises_422():
    from fastapi import HTTPException

    from app.api.routes import ResearchSweep, research_sweep

    class _PG:
        async def recent_footprints(self, symbol, timeframe, limit, row_size=None):
            return []

    with pytest.raises(HTTPException) as ei:
        await research_sweep(_req(_PG()), ResearchSweep(symbol="X", kind="AD", horizon=5, grid={"bogus_key": [1, 2]}))
    assert ei.value.status_code == 422
