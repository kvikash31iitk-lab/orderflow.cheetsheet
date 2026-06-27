// Workspace manager (Phase 3A + 3B sync). Lists factory + local + synced presets with per-row Apply /
// Apply & Replace / Rename / Duplicate / Export / Delete / Set-default / cloud push, a profile filter,
// a conflict resolver, and a "sync local → cloud" migration affordance. Destructive actions
// (delete, apply-replace) require an inline confirm. Uses the app's FloatingWindow + token classes.
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Cloud,
  CloudOff,
  CloudUpload,
  Copy,
  Download,
  FileDown,
  FilePlus2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import FloatingWindow from "../components/FloatingWindow";
import { isModified, originOf, useWorkspaceStore } from "../workspace/useWorkspaceStore";
import { FACTORY_PRESETS, isFactoryId } from "../workspace/factory";
import { captureWorkspaceSnapshot } from "../workspace/capture";
import { DEFAULT_PROFILE, type SyncStatus, type WorkspacePresetV1, type WorkspaceSnapshot } from "../workspace/types";

function fmtWhen(ts: number): string {
  if (!ts) return ""; // factory presets (ts=0) already carry a "built-in" badge
  try {
    return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function profileOf(p: WorkspacePresetV1): string {
  return (typeof p.profile === "string" && p.profile.trim()) || DEFAULT_PROFILE;
}

function summarize(s: WorkspaceSnapshot): string {
  const c = s.context ?? {};
  const sym = c.symbol ?? "current";
  const tf = c.timeframe ?? "·";
  const mode = c.chartDisplayMode === "candle" ? "Candles" : c.chartDisplayMode === "footprint" ? "Footprint" : "—";
  const onPanes = [s.panes?.dom && "DOM", s.panes?.cum && "CVD", s.panes?.hist && "Hist", s.panes?.barStats && "Stats", s.panes?.scanner && "Scan"].filter(Boolean);
  return `${sym} · ${tf} · ${mode}${onPanes.length ? ` · ${onPanes.join("/")}` : ""}`;
}

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard unavailable */
  }
}

function downloadJson(name: string, json: string) {
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, "_") || "workspace"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* download blocked — copy already offered as fallback */
  }
}

const SYNC_META: Record<SyncStatus, { label: string; cls: string }> = {
  local: { label: "Local only", cls: "text-terminal-muted" },
  syncing: { label: "Syncing…", cls: "text-accent" },
  synced: { label: "Synced", cls: "text-flow-buyHi" },
  offline: { label: "Offline", cls: "text-terminal-muted" },
  error: { label: "Sync error", cls: "text-flow-sellHi" },
  conflict: { label: "Conflicts", cls: "text-amber-500" },
};

function SyncBadge({ status }: { status: SyncStatus }) {
  const m = SYNC_META[status];
  const Icon = status === "offline" ? CloudOff : status === "syncing" ? RefreshCw : Cloud;
  return (
    <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium ${m.cls}`} title={`Workspace sync: ${m.label}`}>
      <Icon size={12} className={status === "syncing" ? "animate-spin" : ""} />
      {m.label}
    </span>
  );
}

type Confirm = { kind: "delete" | "replace"; id: string } | null;

export default function WorkspaceManagerModal({ open, onClose, startImport = false }: { open: boolean; onClose: () => void; startImport?: boolean }) {
  const presets = useWorkspaceStore((s) => s.presets);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const defaultId = useWorkspaceStore((s) => s.defaultId);
  const synced = useWorkspaceStore((s) => s.synced);
  const conflicts = useWorkspaceStore((s) => s.conflicts);
  const syncStatus = useWorkspaceStore((s) => s.syncStatus);
  const activeProfile = useWorkspaceStore((s) => s.activeProfile);
  const saveCurrentAs = useWorkspaceStore((s) => s.saveCurrentAs);
  const applyPreset = useWorkspaceStore((s) => s.applyPreset);
  const renamePreset = useWorkspaceStore((s) => s.renamePreset);
  const duplicatePreset = useWorkspaceStore((s) => s.duplicatePreset);
  const deletePreset = useWorkspaceStore((s) => s.deletePreset);
  const exportPreset = useWorkspaceStore((s) => s.exportPreset);
  const importPreset = useWorkspaceStore((s) => s.importPreset);
  const setDefault = useWorkspaceStore((s) => s.setDefault);
  const setActiveProfile = useWorkspaceStore((s) => s.setActiveProfile);
  const pullRemote = useWorkspaceStore((s) => s.pullRemote);
  const pushToCloud = useWorkspaceStore((s) => s.pushToCloud);
  const deleteRemote = useWorkspaceStore((s) => s.deleteRemote);
  const setRemoteDefault = useWorkspaceStore((s) => s.setRemoteDefault);
  const resolveConflict = useWorkspaceStore((s) => s.resolveConflict);

  const [saveName, setSaveName] = useState("");
  const [saveProfile, setSaveProfile] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [importOpen, setImportOpen] = useState(startImport);
  const [importText, setImportText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setImportOpen(startImport);
      setMsg(null);
      setConfirm(null);
      setRenameId(null);
    }
  }, [open, startImport]);

  if (!open) return null;
  const flash = (kind: "ok" | "err", text: string) => setMsg({ kind, text });
  const flashResult = (r: { ok: boolean; error?: string }, okText: string) => flash(r.ok ? "ok" : "err", r.ok ? okText : r.error ?? "Failed");

  const localOnly = presets.filter((p) => originOf(p.id, synced) === "local");
  const userProfiles = Array.from(new Set(presets.map(profileOf))).sort();
  const profileChips = ["All", ...(FACTORY_PRESETS.length ? ["Factory"] : []), ...userProfiles];
  const conflictList = Object.values(conflicts);

  const rows = [...FACTORY_PRESETS, ...presets].filter((p) => {
    const factory = isFactoryId(p.id);
    if (activeProfile === "All") return true;
    if (activeProfile === "Factory") return factory;
    return !factory && profileOf(p) === activeProfile;
  });

  const doSave = () => {
    const r = saveCurrentAs(saveName, saveProfile);
    if (r.ok) {
      setSaveName("");
      setSaveProfile("");
      flash("ok", "Workspace saved");
    } else flash("err", r.error ?? "Could not save");
  };
  const doImport = () => {
    const r = importPreset(importText);
    if (r.ok) {
      setImportText("");
      setImportOpen(false);
      flash("ok", "Workspace imported (not applied)");
    } else flash("err", r.error ?? "Import failed");
  };
  const onFile = (file: File) => {
    file.text().then((t) => flashResult(importPreset(t), "Workspace imported (not applied)")).catch(() => flash("err", "Could not read file"));
  };
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(true);
    try {
      flashResult(await fn(), okText);
    } finally {
      setBusy(false);
    }
  };
  const doSyncAll = async () => {
    setBusy(true);
    let ok = 0;
    try {
      for (const p of localOnly) {
        const r = await pushToCloud(p.id);
        if (r.ok) ok++;
        else break; // stop on first failure (likely offline) to avoid hammering
      }
    } finally {
      setBusy(false);
    }
    flash(ok === localOnly.length ? "ok" : "err", `Synced ${ok}/${localOnly.length} to cloud`);
  };

  return (
    <FloatingWindow
      id="workspace-manager"
      title="Workspaces"
      open={open}
      onClose={onClose}
      defaultRect={{ w: 480, h: 580, x: undefined, y: 70 }}
      minW={400}
      minH={340}
      bodyClassName="flex min-h-0 flex-col"
      closeOnEscape
    >
      {/* save + sync header */}
      <div className="shrink-0 border-b border-terminal-border px-3 py-2.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="section-label">Save current workspace</span>
          <div className="flex items-center gap-2">
            <SyncBadge status={syncStatus} />
            <button onClick={() => run(pullRemote, "Pulled from cloud")} disabled={busy} title="Pull synced workspaces from the backend" className="tbtn !h-6 !px-1.5 !text-[11px] disabled:opacity-40">
              <RefreshCw size={12} /> Pull
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSave()}
            placeholder="Preset name…"
            className="h-7 min-w-0 flex-1 rounded border border-terminal-border bg-terminal-bg px-2 text-[12px] text-terminal-text outline-none focus:border-accent"
          />
          <input
            value={saveProfile}
            onChange={(e) => setSaveProfile(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSave()}
            placeholder="Profile"
            title="Optional profile / scope (defaults to Default)"
            className="h-7 w-20 shrink-0 rounded border border-terminal-border bg-terminal-bg px-2 text-[12px] text-terminal-text outline-none focus:border-accent"
          />
          <button onClick={doSave} disabled={!saveName.trim()} className="tbtn disabled:opacity-40">
            <Plus size={13} /> Save
          </button>
          <button onClick={() => setImportOpen((v) => !v)} title="Import workspace JSON" className={`tbtn ${importOpen ? "tbtn-on" : ""}`}>
            <Upload size={13} /> Import
          </button>
        </div>
        {localOnly.length > 0 && (
          <div className="mt-1.5 flex items-center justify-between rounded bg-terminal-border/30 px-2 py-1 text-[10.5px] text-terminal-muted">
            <span>{localOnly.length} local preset{localOnly.length > 1 ? "s" : ""} not on the cloud.</span>
            <button onClick={doSyncAll} disabled={busy} className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-40">
              <CloudUpload size={12} /> Sync all to cloud
            </button>
          </div>
        )}
        {importOpen && (
          <div className="mt-2 rounded border border-terminal-border bg-terminal-bg/40 p-2">
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Paste workspace JSON here…"
              spellCheck={false}
              className="h-20 w-full resize-none rounded border border-terminal-border bg-terminal-bg px-2 py-1 font-mono text-[11px] text-terminal-text outline-none focus:border-accent"
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <button onClick={doImport} disabled={!importText.trim()} className="tbtn disabled:opacity-40">
                <FilePlus2 size={13} /> Import JSON
              </button>
              <button onClick={() => fileRef.current?.click()} className="tbtn">
                <FileDown size={13} /> From file…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        )}
        {msg && <div className={`mt-1.5 text-[11px] ${msg.kind === "ok" ? "text-flow-buyHi" : "text-flow-sellHi"}`}>{msg.text}</div>}
      </div>

      {/* conflict resolver */}
      {conflictList.length > 0 && (
        <div className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold text-amber-500">
            {conflictList.length} workspace{conflictList.length > 1 ? "s" : ""} differ between this device and the cloud
          </div>
          {conflictList.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-terminal-text">{presets.find((x) => x.id === c.id)?.name ?? c.local.name}</span>
              <button onClick={() => run(() => resolveConflict(c.id, "local"), "Kept local")} disabled={busy} className="tbtn !h-5 !px-1.5 !text-[10px]">
                Keep local
              </button>
              <button onClick={() => run(() => resolveConflict(c.id, "remote"), "Used remote")} disabled={busy} className="tbtn !h-5 !px-1.5 !text-[10px]">
                Use remote
              </button>
              <button onClick={() => run(() => resolveConflict(c.id, "duplicate"), "Kept both")} disabled={busy} className="tbtn !h-5 !px-1.5 !text-[10px]">
                Duplicate
              </button>
            </div>
          ))}
        </div>
      )}

      {/* profile filter */}
      {profileChips.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-terminal-border px-3 py-1.5">
          {profileChips.map((pf) => (
            <button
              key={pf}
              onClick={() => setActiveProfile(pf)}
              className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors ${
                activeProfile === pf ? "bg-accent text-white" : "bg-terminal-border/50 text-terminal-muted hover:text-terminal-text"
              }`}
            >
              {pf}
            </button>
          ))}
        </div>
      )}

      {/* preset list */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-3 pt-2 section-label">Presets · {rows.length}</div>
        <div className="px-1.5 py-1.5">
          {rows.map((p) => {
            const factory = isFactoryId(p.id);
            const origin = factory ? "factory" : originOf(p.id, synced);
            const modified = isModified(p, synced);
            const isActive = activeId === p.id;
            const isDefault = defaultId === p.id;
            const renaming = renameId === p.id;
            return (
              <div
                key={p.id}
                className={`group mb-1 rounded border px-2 py-1.5 ${isActive ? "border-accent/60 bg-accent/5" : "border-transparent hover:border-terminal-border hover:bg-terminal-border/30"}`}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (isDefault) {
                        // a synced default is cloud-managed (no clear-default endpoint) — unsetting it
                        // locally would just be re-applied on the next pull, so change it by starring
                        // another preset instead of silently diverging from the server.
                        if (origin === "synced") return flash("ok", "Cloud default — star another preset to change it");
                        setDefault(null);
                      } else if (origin === "synced") {
                        void run(() => setRemoteDefault(p.id), "Set as cloud default");
                      } else {
                        setDefault(p.id);
                      }
                    }}
                    title={isDefault ? (origin === "synced" ? "Cloud default — star another preset to change" : "Unset default") : origin === "synced" ? "Set as cloud default" : "Set as default"}
                    className={`row-icon-btn ${isDefault ? "!text-flow-exhaustion" : ""}`}
                  >
                    <Star size={13} fill={isDefault ? "currentColor" : "none"} />
                  </button>
                  <div className="min-w-0 flex-1">
                    {renaming ? (
                      <input
                        autoFocus
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const r = renamePreset(p.id, renameText);
                            if (r.ok) setRenameId(null);
                            else flash("err", r.error ?? "Rename failed");
                          } else if (e.key === "Escape") setRenameId(null);
                        }}
                        onBlur={() => setRenameId(null)}
                        className="h-6 w-full rounded border border-accent bg-terminal-bg px-1.5 text-[12px] text-terminal-text outline-none"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold text-terminal-text">{p.name}</span>
                        {factory && <span className="rounded bg-terminal-border/70 px-1 text-[9px] uppercase tracking-wide text-terminal-muted">built-in</span>}
                        {origin === "synced" && (
                          <span className={`inline-flex items-center gap-0.5 rounded px-1 text-[9px] uppercase tracking-wide ${modified ? "bg-amber-500/20 text-amber-500" : "bg-flow-buy/15 text-flow-buyHi"}`}>
                            <Cloud size={9} /> {modified ? "modified" : "synced"}
                          </span>
                        )}
                        {isActive && <span className="rounded bg-accent/20 px-1 text-[9px] uppercase tracking-wide text-accent">active</span>}
                      </div>
                    )}
                    <div className="truncate text-[10px] text-terminal-muted">
                      {summarize(p.snapshot)}
                      {fmtWhen(p.updatedAt) && ` · ${fmtWhen(p.updatedAt)}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button onClick={() => flashResult(applyPreset(p.id, false), `Applied "${p.name}"`)} title="Apply layout (keeps your chart objects)" className="tbtn !h-6 !px-1.5 !text-[11px]">
                      Apply
                    </button>
                    {/* cloud push: local presets → save to cloud; synced+modified → push update */}
                    {!factory && (origin === "local" || modified) && (
                      <button
                        onClick={() => void run(() => pushToCloud(p.id), origin === "local" ? "Saved to cloud" : "Pushed update")}
                        disabled={busy}
                        title={origin === "local" ? "Save to cloud" : "Push local changes to cloud"}
                        className={`row-icon-btn disabled:opacity-40 ${modified ? "!text-amber-500" : ""}`}
                      >
                        <CloudUpload size={13} />
                      </button>
                    )}
                    <button onClick={() => { setRenameText(p.name); setRenameId(p.id); }} disabled={factory} title="Rename" className="row-icon-btn disabled:opacity-30">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => flashResult(duplicatePreset(p.id), "Duplicated")} title="Duplicate" className="row-icon-btn">
                      <Copy size={12} />
                    </button>
                    <button
                      onClick={() => {
                        const json = exportPreset(p.id);
                        if (!json) return flash("err", "Nothing to export");
                        copyText(json);
                        downloadJson(p.name, json);
                        flash("ok", "Exported (copied + downloaded)");
                      }}
                      title="Export JSON (copy + download)"
                      className="row-icon-btn"
                    >
                      <Download size={12} />
                    </button>
                    <button onClick={() => setConfirm({ kind: "delete", id: p.id })} disabled={factory} title="Delete" className="row-icon-btn row-icon-btn-danger disabled:opacity-30">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* secondary row: Apply & Replace / delete confirm (destructive) */}
                <div className="mt-1 flex items-center justify-end gap-2 pl-7">
                  {confirm?.kind === "replace" && confirm.id === p.id ? (
                    <div className="flex items-center gap-1.5 text-[10.5px] text-flow-sellHi">
                      <span>Replace ALL drawings, AVWAPs &amp; indicators?</span>
                      <button onClick={() => { applyPreset(p.id, true); setConfirm(null); flash("ok", "Applied & replaced objects"); }} className="tbtn !h-5 !px-1.5 !text-[10px] !text-flow-sellHi">
                        <Check size={11} /> Replace
                      </button>
                      <button onClick={() => setConfirm(null)} className="tbtn !h-5 !px-1.5 !text-[10px]">Cancel</button>
                    </div>
                  ) : confirm?.kind === "delete" && confirm.id === p.id ? (
                    <div className="flex items-center gap-1.5 text-[10.5px] text-flow-sellHi">
                      <span>{origin === "synced" ? "Delete from this device AND the cloud?" : `Delete “${p.name}”?`}</span>
                      <button
                        onClick={() => {
                          setConfirm(null);
                          if (origin === "synced") void run(() => deleteRemote(p.id), "Deleted (local + cloud)");
                          else {
                            deletePreset(p.id);
                            flash("ok", "Deleted");
                          }
                        }}
                        className="tbtn !h-5 !px-1.5 !text-[10px] !text-flow-sellHi"
                      >
                        <Check size={11} /> Delete
                      </button>
                      <button onClick={() => setConfirm(null)} className="tbtn !h-5 !px-1.5 !text-[10px]">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirm({ kind: "replace", id: p.id })} title="Apply this workspace AND replace all chart objects" className="text-[10px] text-terminal-muted hover:text-flow-sellHi">
                      Apply &amp; Replace all…
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-terminal-border px-3 py-2">
        <button
          onClick={() => {
            const json = JSON.stringify({ version: 1, name: "Current Workspace", snapshot: captureWorkspaceSnapshot(true) }, null, 2);
            copyText(json);
            downloadJson("current-workspace", json);
            flash("ok", "Current workspace exported");
          }}
          className="tbtn"
        >
          <Download size={13} /> Export current
        </button>
        <button onClick={onClose} className="tbtn">
          <X size={13} /> Close
        </button>
      </div>
    </FloatingWindow>
  );
}
