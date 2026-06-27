// Phase 3A — Workspace & Layout Presets.
// A WorkspacePreset is a versioned, JSON-serializable snapshot of the parts of the terminal that make
// up a trader's working layout: chart context, theme, pane visibility + sizes, footprint/bar-stats
// settings, and (optionally) the chart objects (indicators / AVWAPs / drawings). It deliberately
// excludes everything live or sensitive — see captureWorkspaceSnapshot() for the exclusion list.
import type { FootprintMode, FootprintSettings } from "../types/orderflow";
import type { BarStatSettings } from "../barStats/types";
import type { IndicatorExecutionMode, IndicatorInstance } from "../indicators/types";
import type { DrawingObject, SnapMode } from "../drawings/types";
import type { DashboardLayout, PaneVisibility } from "../store/useStore";

export const WORKSPACE_SCHEMA_VERSION = 1 as const;

// Chart context — provider/symbol/timeframe/cluster mode/grouping/display mode.
export interface WorkspaceContext {
  source: "truedata" | "databento";
  symbol: string;
  timeframe: string;
  footprintMode: FootprintMode; // cluster display: Bid/Ask, Delta, Volume, Volume%
  consolidation: number; // price-row grouping multiplier
  chartDisplayMode: "footprint" | "candle";
}

// Pane visibility captured in a workspace (the four Dashboard panes + bar statistics).
export interface WorkspacePanes extends PaneVisibility {
  barStats: boolean;
}

// The state a workspace captures. `indicators`/`drawings` are the "objects" — only applied on an
// explicit Apply & Replace (so a normal Apply never wipes the user's chart objects).
export interface WorkspaceSnapshot {
  // Partial so a layout-focused factory preset can omit symbol/provider (keeping the current chart)
  // while a captured user preset fills every field. applyWorkspaceSnapshot keeps the current value for
  // any field a snapshot omits or sets invalidly.
  context: Partial<WorkspaceContext>;
  theme: "dark" | "light";
  panes: WorkspacePanes;
  layout: DashboardLayout;
  settings: FootprintSettings; // full footprint settings (cluster/columns/color matrix/text/POC/VWAP/...)
  barStatsSettings: BarStatSettings;
  snapMode: SnapMode;
  // NOTE: floating-window (FloatingWindow) drag geometry is intentionally NOT part of a workspace —
  // those dialogs keep their own independent persistence (vikings.windows.v1), so applying a preset
  // never repositions the user's open Settings/Objects/etc. windows.
  // objects — optional; present in user presets, omitted from layout-only factory presets
  indicators?: IndicatorInstance[];
  indicatorExecutionMode?: IndicatorExecutionMode;
  drawings?: DrawingObject[];
}

export interface WorkspacePresetV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  builtin?: boolean; // factory preset (defined in code; cannot be renamed/deleted/overwritten)
  profile?: string; // soft scope/collection label (Phase 3B); defaults to "Default"
  description?: string | null;
  snapshot: WorkspaceSnapshot;
}

export const DEFAULT_PROFILE = "Default";

// ----- Phase 3B: backend sync -----
// Global sync indicator for the whole workspace store.
export type SyncStatus = "local" | "syncing" | "synced" | "offline" | "error" | "conflict";

// A row as returned by the backend GET /api/workspaces (server metadata + the embedded preset).
export interface RemoteWorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  profile: string;
  version: number;
  isDefault: boolean;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
  preset: WorkspacePresetV1;
}

// A same-id divergence between the local copy and the server copy (different updatedAt). Surfaced to
// the user (Keep local / Use remote / Duplicate) — never silently overwritten.
export interface WorkspaceConflict {
  id: string;
  local: WorkspacePresetV1;
  remote: WorkspacePresetV1;
  remoteUpdatedAt: number;
}

// Where a preset lives, for the manager badges.
export type PresetOrigin = "factory" | "local" | "synced";

export interface ApplyWorkspaceOptions {
  // when true, also REPLACE the current indicators/AVWAPs/drawings with the preset's objects.
  // when false (default) only layout/UI/context/settings are applied — chart objects are untouched.
  replaceObjects?: boolean;
}

// Persisted shape under vikings.workspace.presets.v1
export interface PersistedWorkspaces {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  presets: WorkspacePresetV1[];
  activeId: string | null;
  defaultId: string | null;
  // id -> last-known remote updatedAt, so the "synced" badge survives a reload without a re-pull.
  synced?: Record<string, number>;
}

export const MAX_PRESETS = 20;
export const MAX_PRESET_BYTES = 2_000_000; // ~2 MB guard on a single preset's JSON
