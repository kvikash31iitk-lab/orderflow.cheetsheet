// Workspace preset store (Phase 3A + 3B sync). Holds the user's SAVED presets + active/default ids and
// persists them under vikings.workspace.presets.v1. Factory presets live in factory.ts (never persisted)
// and are merged in at the UI layer. All capture/apply goes through the main store via capture.ts.
//
// Phase 3B adds OPTIONAL backend sync: localStorage stays the offline source of truth, and a `synced`
// map (id -> last-known remote updatedAt) tracks which presets live on the backend. If the backend is
// unreachable (no route / PG down / network) every sync action returns gracefully and the local
// workflow keeps working unchanged.
//
// Safety: corrupt localStorage is ignored with a console.warn (never throws); a single preset is capped
// at MAX_PRESET_BYTES and the list at MAX_PRESETS; nothing sensitive is ever written (see capture.ts).
import { create } from "zustand";
import { api } from "../api/rest";
import { captureWorkspaceSnapshot, applyWorkspaceSnapshot } from "./capture";
import { FACTORY_PRESETS, isFactoryId } from "./factory";
import {
  DEFAULT_PROFILE,
  MAX_PRESET_BYTES,
  MAX_PRESETS,
  WORKSPACE_SCHEMA_VERSION,
  type PersistedWorkspaces,
  type PresetOrigin,
  type SyncStatus,
  type WorkspaceConflict,
  type WorkspacePresetV1,
  type WorkspaceSnapshot,
} from "./types";

const LS_KEY = "vikings.workspace.presets.v1";

export interface WorkspaceResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function newId(): string {
  return `ws_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function looksLikeSnapshot(o: unknown): o is WorkspaceSnapshot {
  if (!o || typeof o !== "object") return false;
  const s = o as Record<string, unknown>;
  return (
    typeof s.panes === "object" && s.panes !== null &&
    typeof s.layout === "object" && s.layout !== null &&
    typeof s.settings === "object" && s.settings !== null &&
    typeof s.context === "object"
  );
}

function isValidPreset(o: unknown): o is WorkspacePresetV1 {
  if (!o || typeof o !== "object") return false;
  const p = o as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.name === "string" && looksLikeSnapshot(p.snapshot);
}

function profileOf(p: WorkspacePresetV1): string {
  return (typeof p.profile === "string" && p.profile.trim()) || DEFAULT_PROFILE;
}

// Where a preset lives, for badges: factory (in code), synced (on the backend), or local-only.
export function originOf(id: string, synced: Record<string, number>): PresetOrigin {
  if (isFactoryId(id)) return "factory";
  return id in synced ? "synced" : "local";
}

// A synced preset whose local copy was edited after the last push (updatedAt drifted) — needs a push.
export function isModified(p: WorkspacePresetV1, synced: Record<string, number>): boolean {
  return p.id in synced && synced[p.id] !== p.updatedAt;
}

// Strip to exactly the fields the backend accepts (extra="forbid"); never leak client-only fields.
function cleanForSync(p: WorkspacePresetV1): WorkspacePresetV1 {
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    builtin: false,
    profile: profileOf(p),
    description: p.description ?? null,
    snapshot: p.snapshot,
  };
}

function loadPersisted(): {
  presets: WorkspacePresetV1[];
  activeId: string | null;
  defaultId: string | null;
  synced: Record<string, number>;
} {
  const empty = { presets: [], activeId: null, defaultId: null, synced: {} };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<PersistedWorkspaces>;
    const presets = (Array.isArray(p.presets) ? p.presets : [])
      .filter((x) => {
        const ok = isValidPreset(x);
        if (!ok) console.warn("[workspace] ignoring corrupt/invalid preset in localStorage");
        return ok;
      })
      .map((x) => ({ ...x, builtin: false, version: WORKSPACE_SCHEMA_VERSION }))
      .filter((x) => !isFactoryId(x.id))
      .slice(0, MAX_PRESETS);
    const ids = new Set(presets.map((x) => x.id));
    const activeId = typeof p.activeId === "string" && (ids.has(p.activeId) || isFactoryId(p.activeId)) ? p.activeId : null;
    const defaultId = typeof p.defaultId === "string" && (ids.has(p.defaultId) || isFactoryId(p.defaultId)) ? p.defaultId : null;
    const synced: Record<string, number> = {};
    if (p.synced && typeof p.synced === "object") {
      for (const [k, v] of Object.entries(p.synced)) {
        if (typeof v === "number" && ids.has(k)) synced[k] = v; // only keep marks for presets we still hold
      }
    }
    return { presets, activeId, defaultId, synced };
  } catch {
    console.warn("[workspace] localStorage unreadable/corrupt — starting with no saved presets");
    return empty;
  }
}

function persist(s: { presets: WorkspacePresetV1[]; activeId: string | null; defaultId: string | null; synced: Record<string, number> }): void {
  try {
    const payload: PersistedWorkspaces = {
      version: WORKSPACE_SCHEMA_VERSION,
      presets: s.presets,
      activeId: s.activeId,
      defaultId: s.defaultId,
      synced: s.synced,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

function uniqueName(base: string, presets: WorkspacePresetV1[]): string {
  const names = new Set(presets.map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} copy${n === 2 ? "" : ` ${n}`}`;
    if (!names.has(cand.toLowerCase())) return cand;
  }
  return `${base} ${newId()}`;
}

function presetBytes(p: WorkspacePresetV1): number {
  try {
    return JSON.stringify(p).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// status 0 (network) / 404 (route absent on an old backend) / 503 (PG down) all mean "sync unavailable".
function isOfflineStatus(status: number): boolean {
  return status === 0 || status === 404 || status === 503;
}

interface WorkspaceState {
  presets: WorkspacePresetV1[]; // user presets only (factory presets merged in the UI)
  activeId: string | null;
  defaultId: string | null;
  // --- sync (Phase 3B) ---
  synced: Record<string, number>; // id -> last-known remote updatedAt
  conflicts: Record<string, WorkspaceConflict>;
  syncStatus: SyncStatus;
  syncEnabled: boolean; // discovered: did the backend respond to a sync call?
  activeProfile: string; // manager filter ("All" = no filter)

  // local actions
  saveCurrentAs: (name: string, profile?: string) => WorkspaceResult;
  updatePreset: (id: string) => WorkspaceResult;
  applyPreset: (id: string, replaceObjects: boolean) => WorkspaceResult;
  renamePreset: (id: string, name: string) => WorkspaceResult;
  duplicatePreset: (id: string) => WorkspaceResult;
  deletePreset: (id: string) => void;
  exportPreset: (id: string) => string | null;
  importPreset: (json: string) => WorkspaceResult;
  setDefault: (id: string | null) => void;
  setActiveProfile: (profile: string) => void;

  // sync actions (all graceful when the backend is unavailable)
  pullRemote: () => Promise<WorkspaceResult>;
  pushToCloud: (id: string) => Promise<WorkspaceResult>;
  deleteRemote: (id: string) => Promise<WorkspaceResult>;
  setRemoteDefault: (id: string) => Promise<WorkspaceResult>;
  resolveConflict: (id: string, choice: "local" | "remote" | "duplicate") => Promise<WorkspaceResult>;
}

const initial = loadPersisted();

function findPreset(id: string, userPresets: WorkspacePresetV1[]): WorkspacePresetV1 | undefined {
  return userPresets.find((p) => p.id === id) ?? FACTORY_PRESETS.find((p) => p.id === id);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  presets: initial.presets,
  activeId: initial.activeId,
  defaultId: initial.defaultId,
  synced: initial.synced,
  conflicts: {},
  syncStatus: "local",
  syncEnabled: false,
  activeProfile: "All",

  saveCurrentAs: (rawName, profile) => {
    const name = rawName.trim();
    if (!name) return { ok: false, error: "Name is required" };
    const cur = get();
    if (cur.presets.length >= MAX_PRESETS) return { ok: false, error: `Limit reached (${MAX_PRESETS} presets)` };
    const ts = Date.now();
    const preset: WorkspacePresetV1 = {
      version: WORKSPACE_SCHEMA_VERSION,
      id: newId(),
      name: uniqueName(name, cur.presets),
      createdAt: ts,
      updatedAt: ts,
      profile: profile?.trim() || DEFAULT_PROFILE,
      description: null,
      snapshot: captureWorkspaceSnapshot(true),
    };
    if (presetBytes(preset) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large to save" };
    set({ presets: [...cur.presets, preset], activeId: preset.id });
    persist(get());
    return { ok: true, id: preset.id };
  },

  updatePreset: (id) => {
    if (isFactoryId(id)) return { ok: false, error: "Built-in presets can't be overwritten" };
    const cur = get();
    const idx = cur.presets.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: "Preset not found" };
    const updated: WorkspacePresetV1 = { ...cur.presets[idx], snapshot: captureWorkspaceSnapshot(true), updatedAt: Date.now() };
    if (presetBytes(updated) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large to save" };
    set({ presets: cur.presets.map((p, i) => (i === idx ? updated : p)), activeId: id });
    persist(get());
    return { ok: true, id };
  },

  applyPreset: (id, replaceObjects) => {
    const cur = get();
    const preset = findPreset(id, cur.presets);
    if (!preset) return { ok: false, error: "Preset not found" };
    applyWorkspaceSnapshot(preset.snapshot, replaceObjects);
    set({ activeId: id });
    persist(get());
    return { ok: true, id };
  },

  renamePreset: (id, rawName) => {
    const name = rawName.trim();
    if (!name) return { ok: false, error: "Name is required" };
    if (isFactoryId(id)) return { ok: false, error: "Built-in presets can't be renamed" };
    const cur = get();
    if (!cur.presets.some((p) => p.id === id)) return { ok: false, error: "Preset not found" };
    set({ presets: cur.presets.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)) });
    persist(get());
    return { ok: true, id };
  },

  duplicatePreset: (id) => {
    const cur = get();
    const src = findPreset(id, cur.presets);
    if (!src) return { ok: false, error: "Preset not found" };
    if (cur.presets.length >= MAX_PRESETS) return { ok: false, error: `Limit reached (${MAX_PRESETS} presets)` };
    const ts = Date.now();
    const copy: WorkspacePresetV1 = {
      version: WORKSPACE_SCHEMA_VERSION,
      id: newId(),
      name: uniqueName(src.name, cur.presets),
      createdAt: ts,
      updatedAt: ts,
      profile: profileOf(src),
      description: src.description ?? null,
      snapshot: JSON.parse(JSON.stringify(src.snapshot)) as WorkspaceSnapshot,
    };
    if (presetBytes(copy) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large" };
    set({ presets: [...cur.presets, copy] });
    persist(get());
    return { ok: true, id: copy.id };
  },

  deletePreset: (id) => {
    if (isFactoryId(id)) return;
    const cur = get();
    const synced = { ...cur.synced };
    delete synced[id];
    const conflicts = { ...cur.conflicts };
    delete conflicts[id];
    set({
      presets: cur.presets.filter((p) => p.id !== id),
      activeId: cur.activeId === id ? null : cur.activeId,
      defaultId: cur.defaultId === id ? null : cur.defaultId,
      synced,
      conflicts,
    });
    persist(get());
  },

  exportPreset: (id) => {
    const preset = findPreset(id, get().presets);
    if (!preset) return null;
    return JSON.stringify({ ...preset, builtin: false }, null, 2);
  },

  importPreset: (json) => {
    const cur = get();
    if (cur.presets.length >= MAX_PRESETS) return { ok: false, error: `Limit reached (${MAX_PRESETS} presets)` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: "Not valid JSON" };
    }
    let snapshot: WorkspaceSnapshot | null = null;
    let name = "Imported Workspace";
    let profile = DEFAULT_PROFILE;
    if (isValidPreset(parsed)) {
      const pp = parsed as WorkspacePresetV1;
      snapshot = pp.snapshot;
      if (typeof pp.name === "string") name = pp.name;
      if (typeof pp.profile === "string" && pp.profile.trim()) profile = pp.profile;
    } else if (looksLikeSnapshot(parsed)) {
      snapshot = parsed as WorkspaceSnapshot;
    }
    if (!snapshot) return { ok: false, error: "Not a workspace preset" };
    const ts = Date.now();
    const preset: WorkspacePresetV1 = {
      version: WORKSPACE_SCHEMA_VERSION,
      id: newId(), // imported presets always get a fresh LOCAL id (never collide with a synced id)
      name: uniqueName(name.trim() || "Imported Workspace", cur.presets),
      createdAt: ts,
      updatedAt: ts,
      profile,
      description: null,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot,
    };
    if (presetBytes(preset) > MAX_PRESET_BYTES) return { ok: false, error: "Imported workspace is too large" };
    set({ presets: [...cur.presets, preset] }); // imported preset is NOT auto-applied
    persist(get());
    return { ok: true, id: preset.id };
  },

  setDefault: (id) => {
    const cur = get();
    const defaultId = id && findPreset(id, cur.presets) ? id : null;
    set({ defaultId });
    persist(get());
  },

  setActiveProfile: (profile) => set({ activeProfile: profile }),

  // ----------------------------------------------------------------- sync
  pullRemote: async () => {
    set({ syncStatus: "syncing" });
    const res = await api.workspacesList();
    if (!res.ok) {
      const offline = isOfflineStatus(res.status);
      set({ syncStatus: offline ? "offline" : "error", syncEnabled: !offline });
      return { ok: false, error: offline ? "Sync unavailable (offline)" : res.detail || "Pull failed" };
    }
    const remote = res.data?.presets ?? [];
    const cur = get();
    const presets = cur.presets.slice();
    const synced = { ...cur.synced };
    const conflicts = { ...cur.conflicts };
    let defaultId = cur.defaultId;
    const remoteIds = new Set<string>();
    for (const row of remote) {
      if (!row || typeof row.id !== "string" || row.isArchived || !isValidPreset(row.preset)) continue;
      remoteIds.add(row.id);
      const ru = typeof row.updatedAt === "number" ? row.updatedAt : row.preset.updatedAt || 0;
      const remotePreset: WorkspacePresetV1 = {
        ...row.preset,
        id: row.id,
        builtin: false,
        version: WORKSPACE_SCHEMA_VERSION,
        profile: row.profile || row.preset.profile || DEFAULT_PROFILE,
        updatedAt: ru,
      };
      const idx = presets.findIndex((p) => p.id === row.id);
      if (idx < 0) {
        if (presets.length < MAX_PRESETS) {
          presets.push(remotePreset);
          synced[row.id] = ru;
          delete conflicts[row.id];
        }
      } else if (presets[idx].updatedAt === ru) {
        synced[row.id] = ru; // already in sync
        delete conflicts[row.id];
      } else {
        // same id, different updatedAt -> surface as a conflict; never silently overwrite local
        conflicts[row.id] = { id: row.id, local: presets[idx], remote: remotePreset, remoteUpdatedAt: ru };
      }
      if (row.isDefault) defaultId = row.id;
    }
    // a preset the server no longer has is now local-only (drop its synced mark, keep the local copy)
    for (const id of Object.keys(synced)) if (!remoteIds.has(id)) delete synced[id];
    set({ presets, synced, conflicts, defaultId, syncEnabled: true, syncStatus: Object.keys(conflicts).length ? "conflict" : "synced" });
    persist(get());
    return { ok: true };
  },

  pushToCloud: async (id) => {
    const cur = get();
    const preset = cur.presets.find((p) => p.id === id);
    if (!preset) return { ok: false, error: "Preset not found" };
    if (presetBytes(preset) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large to sync" };
    set({ syncStatus: "syncing" });
    const payload = cleanForSync(preset);
    const known = id in cur.synced;
    let res = known ? await api.workspaceUpdate(id, payload) : await api.workspaceCreate(payload);
    if (!res.ok && res.status === 409) res = await api.workspaceUpdate(id, payload); // exists -> update
    if (!res.ok && res.status === 404 && known) res = await api.workspaceCreate(payload); // gone -> recreate
    if (!res.ok) {
      // NB: 404 is NOT offline here — it's handled above as "gone -> recreate"; only 0/503 are offline.
      const offline = res.status === 0 || res.status === 503;
      set({ syncStatus: offline ? "offline" : "error", syncEnabled: !offline });
      return { ok: false, error: offline ? "Sync unavailable (offline)" : res.detail || "Push failed" };
    }
    const ru = res.data?.updatedAt ?? preset.updatedAt;
    const synced = { ...get().synced, [id]: ru };
    const conflicts = { ...get().conflicts };
    delete conflicts[id];
    set({ synced, conflicts, syncEnabled: true, syncStatus: Object.keys(conflicts).length ? "conflict" : "synced" });
    persist(get());
    return { ok: true, id };
  },

  deleteRemote: async (id) => {
    set({ syncStatus: "syncing" });
    const res = await api.workspaceDelete(id);
    if (!res.ok && res.status !== 404) {
      // 404 = already gone on the server; proceed to remove locally. Only 0/503 are offline here.
      const offline = res.status === 0 || res.status === 503;
      set({ syncStatus: offline ? "offline" : "error", syncEnabled: !offline });
      return { ok: false, error: offline ? "Sync unavailable (offline)" : res.detail || "Delete failed" };
    }
    const cur = get();
    const synced = { ...cur.synced };
    delete synced[id];
    const conflicts = { ...cur.conflicts };
    delete conflicts[id];
    set({
      presets: cur.presets.filter((p) => p.id !== id), // delete locally too (gone everywhere)
      activeId: cur.activeId === id ? null : cur.activeId,
      defaultId: cur.defaultId === id ? null : cur.defaultId,
      synced,
      conflicts,
      syncEnabled: true,
      syncStatus: Object.keys(conflicts).length ? "conflict" : "synced",
    });
    persist(get());
    return { ok: true, id };
  },

  setRemoteDefault: async (id) => {
    set({ syncStatus: "syncing" });
    const res = await api.workspaceSetDefault(id);
    if (!res.ok) {
      const offline = isOfflineStatus(res.status);
      set({ syncStatus: offline ? "offline" : "error", syncEnabled: !offline });
      return { ok: false, error: offline ? "Sync unavailable (offline)" : res.detail || "Set default failed" };
    }
    set({ defaultId: id, syncEnabled: true, syncStatus: Object.keys(get().conflicts).length ? "conflict" : "synced" });
    persist(get());
    return { ok: true, id };
  },

  resolveConflict: async (id, choice) => {
    const cur = get();
    const c = cur.conflicts[id];
    if (!c) return { ok: false, error: "No conflict to resolve" };

    if (choice === "remote") {
      // accept the server copy: replace local + mark synced
      const presets = cur.presets.map((p) => (p.id === id ? c.remote : p));
      const synced = { ...cur.synced, [id]: c.remoteUpdatedAt };
      const conflicts = { ...cur.conflicts };
      delete conflicts[id];
      set({ presets, synced, conflicts, syncStatus: Object.keys(conflicts).length ? "conflict" : "synced" });
      persist(get());
      return { ok: true, id };
    }

    if (choice === "local") {
      // keep local + overwrite the server copy
      const conflicts = { ...cur.conflicts };
      delete conflicts[id];
      set({ conflicts }); // clear first so the push doesn't re-detect it
      return await get().pushToCloud(id);
    }

    // "duplicate": import the remote copy as a NEW local preset; the original local stays local-only
    if (cur.presets.length >= MAX_PRESETS) return { ok: false, error: `Limit reached (${MAX_PRESETS} presets)` };
    const ts = Date.now();
    const copy: WorkspacePresetV1 = {
      ...c.remote,
      id: newId(),
      name: uniqueName(`${c.remote.name} (remote)`, cur.presets),
      builtin: false,
      createdAt: ts,
      updatedAt: ts,
      snapshot: JSON.parse(JSON.stringify(c.remote.snapshot)) as WorkspaceSnapshot,
    };
    const synced = { ...cur.synced };
    delete synced[id]; // the local original no longer claims to be the synced one
    const conflicts = { ...cur.conflicts };
    delete conflicts[id];
    set({ presets: [...cur.presets, copy], synced, conflicts, syncStatus: Object.keys(conflicts).length ? "conflict" : "synced" });
    persist(get());
    return { ok: true, id: copy.id };
  },
}));

// Dev-only handle for local verification (drive save/apply/import/sync deterministically).
// import.meta.env.DEV is false in production builds, so Vite drops this entirely.
if (import.meta.env.DEV) {
  (window as unknown as { __vikingsWorkspace?: typeof useWorkspaceStore }).__vikingsWorkspace = useWorkspaceStore;
}
