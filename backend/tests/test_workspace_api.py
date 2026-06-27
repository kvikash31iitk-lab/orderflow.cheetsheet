"""Workspace preset API (Phase 3B). Mirrors the repo test style: route functions are called
directly with a mock Request whose pipeline carries an in-memory fake Postgres repo."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes import (
    WorkspacePresetBody,
    create_workspace,
    default_workspace,
    delete_workspace,
    get_workspace,
    list_workspaces,
    update_workspace,
)


class _FakePG:
    """In-memory stand-in mirroring PostgresRepo's workspace methods + _row_to_workspace output."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.rows: dict[str, dict] = {}

    @staticmethod
    def _pub(r: dict) -> dict:
        return {
            "id": r["id"], "name": r["name"], "description": r["description"],
            "profile": r["profile"], "version": r["version"], "isDefault": r["is_default"],
            "isArchived": r["is_archived"], "createdAt": r["created_at"], "updatedAt": r["updated_at"],
            "preset": r["preset_json"],
        }

    async def list_workspace_presets(self, profile=None, include_archived=False):
        out = [self._pub(r) for r in self.rows.values()
               if (include_archived or not r["is_archived"]) and (not profile or r["profile"] == profile)]
        return sorted(out, key=lambda x: x["updatedAt"], reverse=True)

    async def get_workspace_preset(self, pid):
        r = self.rows.get(pid)
        return self._pub(r) if r else None

    async def workspace_exists(self, pid):
        return pid in self.rows

    async def create_workspace_preset(self, preset):
        r = {
            "id": preset["id"], "name": preset["name"], "description": preset.get("description"),
            "profile": preset.get("profile") or "Default", "version": int(preset.get("version") or 1),
            "preset_json": preset, "is_default": False, "is_archived": False,
            "created_at": int(preset.get("createdAt") or 0), "updated_at": int(preset.get("updatedAt") or 0),
        }
        self.rows[preset["id"]] = r
        return self._pub(r)

    async def update_workspace_preset(self, pid, preset):
        r = self.rows.get(pid)
        if not r:
            return None
        r.update(name=preset["name"], description=preset.get("description"),
                 profile=preset.get("profile") or "Default", version=int(preset.get("version") or 1),
                 preset_json=preset, updated_at=int(preset.get("updatedAt") or 0), is_archived=False)
        return self._pub(r)

    async def archive_workspace_preset(self, pid):
        r = self.rows.get(pid)
        if not r or r["is_archived"]:
            return False
        r["is_archived"] = True
        r["is_default"] = False
        return True

    async def set_default_workspace_preset(self, pid):
        r = self.rows.get(pid)
        if not r or r["is_archived"]:
            return False
        for rr in self.rows.values():
            rr["is_default"] = rr["id"] == pid
        return True


def _req(pg):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(pipeline=SimpleNamespace(pg=pg))))


def _preset(pid="ws_a", name="Test", updated=1000, profile="Default", snapshot=None) -> dict:
    return {
        "version": 1, "id": pid, "name": name, "createdAt": 1, "updatedAt": updated,
        "builtin": False, "profile": profile, "description": None,
        "snapshot": snapshot if snapshot is not None else {
            "context": {"symbol": "GC.V.0", "timeframe": "2m"}, "theme": "dark",
            "panes": {"dom": True, "scanner": True}, "layout": {"rightColumnWidth": 320},
            "settings": {"showPoc": True}, "barStatsSettings": {"enabled": ["volume"]}, "snapMode": "off",
        },
    }


def _body(id="ws_a", name="Test", updated=1000, profile="Default", snapshot=None, version=1) -> WorkspacePresetBody:
    p = _preset(pid=id, name=name, updated=updated, profile=profile, snapshot=snapshot)
    p["version"] = version
    return WorkspacePresetBody(**p)


# ---------------------------------------------------------------- happy paths
async def test_create_and_get():
    pg = _FakePG()
    out = await create_workspace(_req(pg), _body())
    assert out["id"] == "ws_a" and out["isArchived"] is False
    assert out["preset"]["snapshot"]["context"]["symbol"] == "GC.V.0"
    got = await get_workspace(_req(pg), "ws_a")
    assert got["id"] == "ws_a"


async def test_list_excludes_archived():
    pg = _FakePG()
    await create_workspace(_req(pg), _body(id="ws_a", name="A"))
    await create_workspace(_req(pg), _body(id="ws_b", name="B"))
    await delete_workspace(_req(pg), "ws_b")
    listed = await list_workspaces(_req(pg))
    ids = [p["id"] for p in listed["presets"]]
    assert ids == ["ws_a"]
    # soft-delete: the row still exists, just archived (never hard-deleted)
    assert pg.rows["ws_b"]["is_archived"] is True
    # and GET on an archived preset 404s
    with pytest.raises(HTTPException) as ei:
        await get_workspace(_req(pg), "ws_b")
    assert ei.value.status_code == 404


async def test_update_replaces_fields():
    pg = _FakePG()
    await create_workspace(_req(pg), _body(id="ws_a", name="Old", updated=1000))
    out = await update_workspace(_req(pg), "ws_a", _body(id="ws_a", name="New", updated=2000))
    assert out["name"] == "New" and out["updatedAt"] == 2000
    # path id wins even if body id differs
    out2 = await update_workspace(_req(pg), "ws_a", _body(id="ws_DIFFERENT", name="X", updated=3000))
    assert out2["id"] == "ws_a" and out2["preset"]["id"] == "ws_a"


async def test_update_missing_404():
    pg = _FakePG()
    with pytest.raises(HTTPException) as ei:
        await update_workspace(_req(pg), "nope", _body(id="nope"))
    assert ei.value.status_code == 404


async def test_create_conflict_409():
    pg = _FakePG()
    await create_workspace(_req(pg), _body(id="ws_a"))
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(id="ws_a"))
    assert ei.value.status_code == 409


async def test_default_uniqueness():
    pg = _FakePG()
    await create_workspace(_req(pg), _body(id="ws_a"))
    await create_workspace(_req(pg), _body(id="ws_b"))
    await default_workspace(_req(pg), "ws_a")
    assert pg.rows["ws_a"]["is_default"] and not pg.rows["ws_b"]["is_default"]
    await default_workspace(_req(pg), "ws_b")  # switching default unsets the previous one
    assert pg.rows["ws_b"]["is_default"] and not pg.rows["ws_a"]["is_default"]


async def test_default_missing_404():
    pg = _FakePG()
    with pytest.raises(HTTPException) as ei:
        await default_workspace(_req(pg), "nope")
    assert ei.value.status_code == 404


# ---------------------------------------------------------------- validation
async def test_wrong_version_rejected():
    pg = _FakePG()
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(version=2))
    assert ei.value.status_code == 422


async def test_blank_name_rejected():
    pg = _FakePG()
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(name="   "))
    assert ei.value.status_code == 422


@pytest.mark.parametrize("snapshot", [
    {"context": {"symbol": "X"}, "positions": [{"qty": 1}]},          # top-level forbidden key
    {"context": {"symbol": "X", "candles": [1, 2, 3]}},                # nested forbidden key
    {"settings": {"auth": {"apiKey": "leak"}}},                       # deep secret-ish key
])
async def test_forbidden_live_data_keys_rejected(snapshot):
    pg = _FakePG()
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(snapshot=snapshot))
    assert ei.value.status_code == 422
    assert not pg.rows  # nothing was persisted


async def test_indicator_script_text_is_allowed():
    # the words appear as VALUES inside an indicator script string, not as object keys — allowed.
    pg = _FakePG()
    snap = {"context": {"symbol": "X"}, "indicators": [{"id": "i1", "script": "// uses bar.cumDelta and a token-like name"}]}
    out = await create_workspace(_req(pg), _body(snapshot=snap))
    assert out["id"] == "ws_a"


async def test_panes_scanner_bool_allowed_but_object_rejected():
    pg = _FakePG()
    # the legit boolean UI flag is allowed
    ok = await create_workspace(_req(pg), _body(snapshot={"context": {"symbol": "X"}, "panes": {"dom": True, "scanner": False}}))
    assert ok["id"] == "ws_a"
    # but a non-boolean value under panes.scanner (e.g. smuggled scanner data) is rejected
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(id="ws_b", snapshot={"context": {"symbol": "X"}, "panes": {"scanner": {"rows": [{"sym": "X", "bid": 1.0}]}}}))
    assert ei.value.status_code == 422


async def test_oversized_rejected():
    pg = _FakePG()
    big = {"context": {"symbol": "X"}, "settings": {"blob": "x" * 2_100_000}}
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body(snapshot=big))
    assert ei.value.status_code == 413
    assert not pg.rows


def test_unknown_top_level_field_rejected():
    # extra="forbid" on the body model → unknown top-level fields fail to parse (FastAPI returns 422).
    with pytest.raises(ValidationError):
        WorkspacePresetBody(**{**_preset(), "evil": 123})


# ---------------------------------------------------------------- offline / PG down
async def test_create_when_pg_disabled_503():
    pg = _FakePG(enabled=False)
    with pytest.raises(HTTPException) as ei:
        await create_workspace(_req(pg), _body())
    assert ei.value.status_code == 503


async def test_list_when_pg_disabled_503():
    # GET is routed through _ws_pg so a down DB returns 503 (the client treats that as offline and keeps
    # its local presets) rather than an ambiguous empty list that looks like "the server has no presets".
    with pytest.raises(HTTPException) as ei:
        await list_workspaces(_req(_FakePG(enabled=False)))
    assert ei.value.status_code == 503
