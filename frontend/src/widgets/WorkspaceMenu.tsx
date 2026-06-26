// Workspace dropdown for the header toolbar (Phase 3A). Compact menu to save / update / manage / import
// / export workspaces and reset the layout to factory. Opens the WorkspaceManagerModal for the heavy UI.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, LayoutDashboard, RotateCcw, Save, Settings2, Upload } from "lucide-react";
import { useStore } from "../store/useStore";
import { useWorkspaceStore } from "../workspace/useWorkspaceStore";
import { FACTORY_PRESETS, isFactoryId } from "../workspace/factory";
import { captureWorkspaceSnapshot } from "../workspace/capture";
import WorkspaceManagerModal from "./WorkspaceManagerModal";

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
    /* ignore */
  }
}

function Row({ icon, label, onClick, disabled, danger }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors disabled:opacity-40 ${
        danger ? "text-flow-sellHi hover:bg-flow-sell/10" : "text-terminal-text hover:bg-terminal-border/50"
      }`}
    >
      <span className="shrink-0 text-terminal-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export default function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerImport, setManagerImport] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const saveRef = useRef<HTMLInputElement>(null);

  const presets = useWorkspaceStore((s) => s.presets);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const saveCurrentAs = useWorkspaceStore((s) => s.saveCurrentAs);
  const updatePreset = useWorkspaceStore((s) => s.updatePreset);
  const resetWorkspaceLayout = useStore((s) => s.resetWorkspaceLayout);

  const active = activeId ? [...FACTORY_PRESETS, ...presets].find((p) => p.id === activeId) : undefined;
  const canUpdate = !!activeId && !isFactoryId(activeId) && presets.some((p) => p.id === activeId);

  useEffect(() => {
    if (saving) saveRef.current?.focus();
  }, [saving]);

  // Escape closes the dropdown (sub-state inputs stopPropagation so their own Escape just backs out).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSaving(false);
        setSaveName("");
        setConfirmReset(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    setSaving(false);
    setSaveName("");
    setConfirmReset(false);
  };
  const doSave = () => {
    if (!saveName.trim()) return;
    saveCurrentAs(saveName);
    close();
  };

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Workspaces — save / restore / manage layouts"
        className={`inline-flex h-7 max-w-[160px] select-none items-center gap-1 rounded-md border px-2 text-[12px] font-medium transition-colors ${
          open ? "border-accent/50 bg-accent/10 text-accent" : "border-terminal-border bg-terminal-bg/60 text-terminal-text hover:bg-terminal-border/40"
        }`}
      >
        <LayoutDashboard size={14} className="shrink-0 text-terminal-muted" />
        <span className="truncate">{active ? active.name : "Workspace"}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="popover absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden py-1">
            {saving ? (
              <div className="px-2 py-1.5">
                <input
                  ref={saveRef}
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doSave();
                    else if (e.key === "Escape") {
                      e.stopPropagation(); // back out of the save sub-state only, keep the menu open
                      setSaving(false);
                    }
                  }}
                  placeholder="New preset name…"
                  className="h-7 w-full rounded border border-accent bg-terminal-bg px-2 text-[12px] text-terminal-text outline-none"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button onClick={doSave} disabled={!saveName.trim()} className="tbtn flex-1 justify-center disabled:opacity-40">
                    <Save size={13} /> Save preset
                  </button>
                  <button onClick={() => setSaving(false)} className="tbtn">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <Row icon={<Save size={13} />} label="Save current as preset…" onClick={() => setSaving(true)} />
                <Row icon={<Save size={13} />} label={canUpdate ? `Update “${active?.name}”` : "Update current preset"} disabled={!canUpdate} onClick={() => { updatePreset(activeId!); close(); }} />
                <div className="my-1 h-px bg-terminal-border" />
                <Row icon={<Settings2 size={13} />} label="Manage workspaces…" onClick={() => { setManagerImport(false); setManagerOpen(true); close(); }} />
                <Row icon={<Upload size={13} />} label="Import workspace JSON…" onClick={() => { setManagerImport(true); setManagerOpen(true); close(); }} />
                <Row
                  icon={<Download size={13} />}
                  label="Export current workspace"
                  onClick={() => {
                    const json = JSON.stringify({ version: 1, name: active?.name ?? "Current Workspace", snapshot: captureWorkspaceSnapshot(true) }, null, 2);
                    copyText(json);
                    downloadJson("current-workspace", json);
                    close();
                  }}
                />
                <div className="my-1 h-px bg-terminal-border" />
                {confirmReset ? (
                  <div className="px-3 py-1.5">
                    <div className="mb-1.5 text-[11px] text-flow-sellHi">Reset panes &amp; sizes to factory? Chart objects are kept.</div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => { resetWorkspaceLayout(); close(); }} className="tbtn flex-1 justify-center !text-flow-sellHi">
                        <RotateCcw size={13} /> Reset layout
                      </button>
                      <button onClick={() => setConfirmReset(false)} className="tbtn">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <Row icon={<RotateCcw size={13} />} label="Reset to factory layout" danger onClick={() => setConfirmReset(true)} />
                )}
              </>
            )}
          </div>
        </>
      )}

      <WorkspaceManagerModal open={managerOpen} onClose={() => setManagerOpen(false)} startImport={managerImport} />
    </div>
  );
}
