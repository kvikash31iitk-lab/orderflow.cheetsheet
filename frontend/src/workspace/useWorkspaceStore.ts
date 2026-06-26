// Workspace preset store (Phase 3A). Holds the user's SAVED presets + the active/default ids and
// persists them under vikings.workspace.presets.v1. Factory presets live in factory.ts (never persisted)
// and are merged in at the UI layer. All capture/apply goes through the main store via capture.ts.
//
// Safety: corrupt localStorage is ignored with a console.warn (never throws); a single preset is capped
// at MAX_PRESET_BYTES and the list at MAX_PRESETS; nothing sensitive is ever written (see capture.ts).
import { create } from "zustand";
import { captureWorkspaceSnapshot, applyWorkspaceSnapshot } from "./capture";
import { FACTORY_PRESETS, isFactoryId } from "./factory";
import {
  MAX_PRESET_BYTES,
  MAX_PRESETS,
  WORKSPACE_SCHEMA_VERSION,
  type PersistedWorkspaces,
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

// Light structural check that an unknown object is a plausible workspace snapshot. Deep field-level
// sanitization happens in the store's applyWorkspaceSnapshot, so this only guards against random JSON.
function looksLikeSnapshot(o: unknown): o is WorkspaceSnapshot {
  if (!o || typeof o !== "object") return false;
  const s = o as Record<string, unknown>;
  return (
    typeof s.panes === "object" &&
    s.panes !== null &&
    typeof s.layout === "object" &&
    s.layout !== null &&
    typeof s.settings === "object" &&
    s.settings !== null &&
    typeof s.context === "object"
  );
}

function isValidPreset(o: unknown): o is WorkspacePresetV1 {
  if (!o || typeof o !== "object") return false;
  const p = o as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.name === "string" && looksLikeSnapshot(p.snapshot);
}

function loadPersisted(): { presets: WorkspacePresetV1[]; activeId: string | null; defaultId: string | null } {
  const empty = { presets: [], activeId: null, defaultId: null };
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
      // never trust a stored builtin flag / factory id from disk
      .map((x) => ({ ...x, builtin: false, version: WORKSPACE_SCHEMA_VERSION }))
      .filter((x) => !isFactoryId(x.id))
      .slice(0, MAX_PRESETS);
    const ids = new Set(presets.map((x) => x.id));
    const activeId = typeof p.activeId === "string" && (ids.has(p.activeId) || isFactoryId(p.activeId)) ? p.activeId : null;
    const defaultId = typeof p.defaultId === "string" && (ids.has(p.defaultId) || isFactoryId(p.defaultId)) ? p.defaultId : null;
    return { presets, activeId, defaultId };
  } catch {
    console.warn("[workspace] localStorage unreadable/corrupt — starting with no saved presets");
    return empty;
  }
}

function persist(state: { presets: WorkspacePresetV1[]; activeId: string | null; defaultId: string | null }): void {
  try {
    const payload: PersistedWorkspaces = {
      version: WORKSPACE_SCHEMA_VERSION,
      presets: state.presets,
      activeId: state.activeId,
      defaultId: state.defaultId,
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

interface WorkspaceState {
  presets: WorkspacePresetV1[]; // user presets only (factory presets merged in the UI)
  activeId: string | null;
  defaultId: string | null;

  saveCurrentAs: (name: string) => WorkspaceResult;
  updatePreset: (id: string) => WorkspaceResult; // re-capture current state into an existing user preset
  applyPreset: (id: string, replaceObjects: boolean) => WorkspaceResult;
  renamePreset: (id: string, name: string) => WorkspaceResult;
  duplicatePreset: (id: string) => WorkspaceResult;
  deletePreset: (id: string) => void;
  exportPreset: (id: string) => string | null; // pretty JSON, or null if not found
  importPreset: (json: string) => WorkspaceResult; // adds (does NOT auto-apply)
  setDefault: (id: string | null) => void;
}

const initial = loadPersisted();

// Look up a preset by id across user + factory presets.
function findPreset(id: string, userPresets: WorkspacePresetV1[]): WorkspacePresetV1 | undefined {
  return userPresets.find((p) => p.id === id) ?? FACTORY_PRESETS.find((p) => p.id === id);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  presets: initial.presets,
  activeId: initial.activeId,
  defaultId: initial.defaultId,

  saveCurrentAs: (rawName) => {
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
      snapshot: captureWorkspaceSnapshot(true),
    };
    if (presetBytes(preset) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large to save" };
    const presets = [...cur.presets, preset];
    set({ presets, activeId: preset.id });
    persist({ presets, activeId: preset.id, defaultId: cur.defaultId });
    return { ok: true, id: preset.id };
  },

  updatePreset: (id) => {
    if (isFactoryId(id)) return { ok: false, error: "Built-in presets can't be overwritten" };
    const cur = get();
    const idx = cur.presets.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: "Preset not found" };
    const updated: WorkspacePresetV1 = {
      ...cur.presets[idx],
      snapshot: captureWorkspaceSnapshot(true),
      updatedAt: Date.now(),
    };
    if (presetBytes(updated) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large to save" };
    const presets = cur.presets.map((p, i) => (i === idx ? updated : p));
    set({ presets, activeId: id });
    persist({ presets, activeId: id, defaultId: cur.defaultId });
    return { ok: true, id };
  },

  applyPreset: (id, replaceObjects) => {
    const cur = get();
    const preset = findPreset(id, cur.presets);
    if (!preset) return { ok: false, error: "Preset not found" };
    applyWorkspaceSnapshot(preset.snapshot, replaceObjects);
    set({ activeId: id });
    persist({ presets: cur.presets, activeId: id, defaultId: cur.defaultId });
    return { ok: true, id };
  },

  renamePreset: (id, rawName) => {
    const name = rawName.trim();
    if (!name) return { ok: false, error: "Name is required" };
    if (isFactoryId(id)) return { ok: false, error: "Built-in presets can't be renamed" };
    const cur = get();
    if (!cur.presets.some((p) => p.id === id)) return { ok: false, error: "Preset not found" };
    const presets = cur.presets.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p));
    set({ presets });
    persist({ presets, activeId: cur.activeId, defaultId: cur.defaultId });
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
      snapshot: JSON.parse(JSON.stringify(src.snapshot)) as WorkspaceSnapshot,
    };
    if (presetBytes(copy) > MAX_PRESET_BYTES) return { ok: false, error: "Workspace is too large" };
    const presets = [...cur.presets, copy];
    set({ presets });
    persist({ presets, activeId: cur.activeId, defaultId: cur.defaultId });
    return { ok: true, id: copy.id };
  },

  deletePreset: (id) => {
    if (isFactoryId(id)) return; // factory presets can't be deleted
    const cur = get();
    const presets = cur.presets.filter((p) => p.id !== id);
    const activeId = cur.activeId === id ? null : cur.activeId;
    const defaultId = cur.defaultId === id ? null : cur.defaultId;
    set({ presets, activeId, defaultId });
    persist({ presets, activeId, defaultId });
  },

  exportPreset: (id) => {
    const preset = findPreset(id, get().presets);
    if (!preset) return null;
    // export a clean, builtin-flag-free copy
    const out: WorkspacePresetV1 = { ...preset, builtin: false };
    return JSON.stringify(out, null, 2);
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
    // accept either a full preset {…, snapshot} or a bare snapshot object
    let snapshot: WorkspaceSnapshot | null = null;
    let name = "Imported Workspace";
    if (isValidPreset(parsed)) {
      snapshot = (parsed as WorkspacePresetV1).snapshot;
      if (typeof (parsed as WorkspacePresetV1).name === "string") name = (parsed as WorkspacePresetV1).name;
    } else if (looksLikeSnapshot(parsed)) {
      snapshot = parsed as WorkspaceSnapshot;
    }
    if (!snapshot) return { ok: false, error: "Not a workspace preset" };
    const ts = Date.now();
    const preset: WorkspacePresetV1 = {
      version: WORKSPACE_SCHEMA_VERSION,
      id: newId(),
      name: uniqueName(name.trim() || "Imported Workspace", cur.presets),
      createdAt: ts,
      updatedAt: ts,
      // re-clone so we never retain a reference to the caller's object
      snapshot: JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot,
    };
    if (presetBytes(preset) > MAX_PRESET_BYTES) return { ok: false, error: "Imported workspace is too large" };
    const presets = [...cur.presets, preset];
    set({ presets }); // imported preset is NOT auto-applied
    persist({ presets, activeId: cur.activeId, defaultId: cur.defaultId });
    return { ok: true, id: preset.id };
  },

  setDefault: (id) => {
    const cur = get();
    const defaultId = id && findPreset(id, cur.presets) ? id : null;
    set({ defaultId });
    persist({ presets: cur.presets, activeId: cur.activeId, defaultId });
  },
}));

// Dev-only handle for local verification (drive save/apply/import/etc. deterministically).
// import.meta.env.DEV is false in production builds, so Vite drops this entirely.
if (import.meta.env.DEV) {
  (window as unknown as { __vikingsWorkspace?: typeof useWorkspaceStore }).__vikingsWorkspace = useWorkspaceStore;
}
