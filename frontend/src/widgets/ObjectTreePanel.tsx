// Object Tree — unified, grouped management of everything applied to the chart
// (indicators, anchored VWAPs, drawings), TradingView-style. Lives in a FloatingWindow.
// Every object is selectable, hideable, lockable (drawings) and DELETABLE here. Drawings
// are scoped to the active symbol (they only render on the symbol they were drawn on).
// Group headers collapse/expand and carry a right-click menu (show/hide all, lock all,
// copy summary, clear); each row carries its own app right-click menu.
import { useState, type MouseEvent, type ReactNode } from "react";
import { Anchor, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Lock, LockOpen, Settings, Trash2, X } from "lucide-react";
import { useStore } from "../store/useStore";
import FloatingWindow from "../components/FloatingWindow";
import { TOOL_ICONS } from "../drawings/toolIcons";
import { formatIstDateTime } from "../lib/time";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import IndicatorContextMenu from "./IndicatorContextMenu";
import DrawingRowMenu from "./DrawingRowMenu";
import type { IndicatorInstance } from "../indicators/types";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

function Section({
  title,
  extra,
  collapsed,
  onToggle,
  onContextMenu,
  children,
}: {
  title: string;
  extra?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-terminal-border">
      <div className="flex items-center justify-between bg-terminal-bg/30 px-3 py-1.5" onContextMenu={onContextMenu}>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {collapsed ? (
            <ChevronRight size={12} className="shrink-0 text-terminal-muted" />
          ) : (
            <ChevronDown size={12} className="shrink-0 text-terminal-muted" />
          )}
          <span className="section-label truncate">{title}</span>
        </button>
        {extra}
      </div>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-center text-[11px] text-terminal-muted">{children}</div>;
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`row-icon-btn ${danger ? "row-icon-btn-danger" : ""}`}
    >
      {children}
    </button>
  );
}

// One indicator / anchored-VWAP row: enable switch · name (+ anchor time) · settings · remove.
// `selectable` AVWAP rows highlight + select-on-click (they're pickable on the chart).
function IndicatorRow({
  ind,
  selectable,
  selected,
  onSelect,
  onToggle,
  onSettings,
  onRemove,
  onContextMenu,
}: {
  ind: IndicatorInstance;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onToggle: () => void;
  onSettings: () => void;
  onRemove: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const isAvwap = ind.kind === "anchored-vwap";
  const anchorMs = isAvwap ? Number(ind.inputs.anchorTime ?? 0) : 0;
  return (
    <div
      onClick={selectable ? onSelect : undefined}
      onContextMenu={onContextMenu}
      className={`flex items-center gap-2 px-3 py-1.5 ${selectable ? "cursor-pointer" : ""} ${
        selected ? "bg-flow-exhaustion/15" : "hover:bg-terminal-border/50"
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={ind.enabled}
        data-on={ind.enabled}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="switch"
        title={ind.enabled ? "Disable" : "Enable"}
      />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${ind.enabled ? "" : "text-terminal-muted"}`}>{ind.name}</div>
        {anchorMs > 0 && (
          <div className="flex items-center gap-1 truncate text-[10px] text-terminal-muted">
            <Anchor size={10} /> {formatIstDateTime(anchorMs)} IST
          </div>
        )}
      </div>
      {!isAvwap && <span className="text-[10px] text-terminal-muted">{ind.overlay ? "overlay" : "pane"}</span>}
      <IconBtn title="Settings" onClick={onSettings}>
        <Settings size={13} />
      </IconBtn>
      <IconBtn title="Remove" onClick={onRemove} danger>
        <X size={13} />
      </IconBtn>
    </div>
  );
}

type Group = "ind" | "avwap" | "draw";

export default function ObjectTreePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const symbol = useStore((s) => s.symbol);
  const drawings = useStore((s) => s.drawings);
  const selectedId = useStore((s) => s.selectedDrawingId);
  const selectDrawing = useStore((s) => s.selectDrawing);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const toggleVisible = useStore((s) => s.toggleDrawingVisible);
  const toggleLock = useStore((s) => s.toggleDrawingLock);
  const clearDrawings = useStore((s) => s.clearDrawings);
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const removeAllAnchoredVwaps = useStore((s) => s.removeAllAnchoredVwaps);
  const setSettingsIndicatorId = useStore((s) => s.setSettingsIndicatorId);
  const selectedIndicatorId = useStore((s) => s.selectedIndicatorId);
  const selectIndicator = useStore((s) => s.selectIndicator);

  const symDrawings = drawings.filter((d) => d.symbol === symbol);
  const regular = indicators.filter((i) => i.kind !== "anchored-vwap");
  const avwaps = indicators.filter((i) => i.kind === "anchored-vwap");

  const [collapsed, setCollapsed] = useState<Set<Group>>(new Set());
  const [indMenu, setIndMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drawMenu, setDrawMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [grpMenu, setGrpMenu] = useState<{ group: Group; x: number; y: number } | null>(null);

  const toggleCollapse = (g: Group) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  const closeAll = () => {
    setIndMenu(null);
    setDrawMenu(null);
    setGrpMenu(null);
  };
  const openInd = (id: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    setIndMenu({ id, x: e.clientX, y: e.clientY });
  };
  const openDraw = (id: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    setDrawMenu({ id, x: e.clientX, y: e.clientY });
  };
  const openGrp = (group: Group, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    setGrpMenu({ group, x: e.clientX, y: e.clientY });
  };

  const drawObj = drawMenu ? symDrawings.find((d) => d.id === drawMenu.id) : null;

  // ---- group-menu helpers (computed for the open group) ----
  const grpItems: { name: string }[] =
    grpMenu?.group === "draw" ? symDrawings : grpMenu?.group === "avwap" ? avwaps : regular;
  const grpTitle = grpMenu?.group === "draw" ? "Drawings" : grpMenu?.group === "avwap" ? "Anchored VWAPs" : "Indicators";
  const grpAnyOn =
    grpMenu?.group === "draw"
      ? symDrawings.some((d) => d.visible)
      : (grpMenu?.group === "avwap" ? avwaps : regular).some((i) => i.enabled);

  return (
    <FloatingWindow
      id="object-tree"
      title="Objects"
      open={open}
      onClose={onClose}
      defaultRect={{ w: 300, h: 460, x: undefined, y: 90 }}
      minW={240}
      minH={220}
      bodyClassName="p-0"
    >
      <div className="flex flex-col text-xs text-terminal-text">
        <Section
          title="Indicators"
          collapsed={collapsed.has("ind")}
          onToggle={() => toggleCollapse("ind")}
          onContextMenu={(e) => openGrp("ind", e)}
        >
          {regular.length === 0 && <Empty>No indicators — add one from the ƒx panel.</Empty>}
          {regular.map((i) => (
            <IndicatorRow
              key={i.id}
              ind={i}
              onToggle={() => toggleIndicator(i.id)}
              onSettings={() => setSettingsIndicatorId(i.id)}
              onRemove={() => removeIndicator(i.id)}
              onContextMenu={(e) => openInd(i.id, e)}
            />
          ))}
        </Section>

        <Section
          title="Anchored VWAPs"
          collapsed={collapsed.has("avwap")}
          onToggle={() => toggleCollapse("avwap")}
          onContextMenu={(e) => openGrp("avwap", e)}
          extra={
            avwaps.length ? (
              <button onClick={() => removeAllAnchoredVwaps()} className="tbtn-link hover:text-flow-sellHi">
                clear all
              </button>
            ) : null
          }
        >
          {avwaps.length === 0 && <Empty>None yet — click AVWAP, then a candle.</Empty>}
          {avwaps.map((i) => (
            <IndicatorRow
              key={i.id}
              ind={i}
              selectable
              selected={i.id === selectedIndicatorId}
              onSelect={() => selectIndicator(i.id)}
              onToggle={() => toggleIndicator(i.id)}
              onSettings={() => setSettingsIndicatorId(i.id)}
              onRemove={() => removeIndicator(i.id)}
              onContextMenu={(e) => openInd(i.id, e)}
            />
          ))}
        </Section>

        <Section
          title={`Drawings · ${symbol}`}
          collapsed={collapsed.has("draw")}
          onToggle={() => toggleCollapse("draw")}
          onContextMenu={(e) => openGrp("draw", e)}
          extra={
            symDrawings.length ? (
              <button onClick={() => clearDrawings(symbol)} className="tbtn-link hover:text-flow-sellHi">
                clear all
              </button>
            ) : null
          }
        >
          {symDrawings.length === 0 && <Empty>No drawings yet — pick a tool from the left toolbar.</Empty>}
          {symDrawings.map((d) => {
            const TypeIcon = TOOL_ICONS[d.type];
            return (
              <div
                key={d.id}
                onClick={() => {
                  selectDrawing(d.id);
                  setActiveTool("select");
                }}
                onContextMenu={(e) => openDraw(d.id, e)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                  d.id === selectedId ? "bg-flow-delta/15" : "hover:bg-terminal-border/50"
                }`}
              >
                <span className="flex w-4 shrink-0 justify-center text-terminal-muted">
                  {TypeIcon && <TypeIcon size={13} />}
                </span>
                <span
                  className={`flex-1 truncate ${d.visible ? "" : "text-terminal-muted line-through"}`}
                  style={{ color: d.visible ? d.style.color : undefined }}
                >
                  {d.name}
                </span>
                <IconBtn title={d.visible ? "Hide" : "Show"} onClick={() => toggleVisible(d.id)}>
                  {d.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </IconBtn>
                <IconBtn title={d.locked ? "Unlock" : "Lock"} onClick={() => toggleLock(d.id)}>
                  {d.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </IconBtn>
                <IconBtn title="Remove" onClick={() => removeDrawing(d.id)} danger>
                  <X size={13} />
                </IconBtn>
              </div>
            );
          })}
        </Section>
      </div>

      {/* indicator / AVWAP row menu (reuses the shared indicator menu) */}
      {indMenu && <IndicatorContextMenu indicatorId={indMenu.id} x={indMenu.x} y={indMenu.y} onClose={() => setIndMenu(null)} />}

      {/* drawing row menu */}
      {drawMenu && drawObj && <DrawingRowMenu x={drawMenu.x} y={drawMenu.y} drawing={drawObj} onClose={() => setDrawMenu(null)} />}

      {/* group-header menu */}
      {grpMenu && (
        <TerminalMenu x={grpMenu.x} y={grpMenu.y} onClose={() => setGrpMenu(null)}>
          {(() => {
            const g = grpMenu.group;
            const close = () => setGrpMenu(null);
            const act = (fn: () => void) => () => {
              fn();
              close();
            };
            const isCollapsed = collapsed.has(g);
            const hasItems = grpItems.length > 0;
            return (
              <>
                <MenuItem
                  icon={isCollapsed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  label={isCollapsed ? "Expand" : "Collapse"}
                  onClick={act(() => toggleCollapse(g))}
                />
                {hasItems && <MenuSeparator />}
                {hasItems &&
                  (grpAnyOn ? (
                    <MenuItem
                      icon={<EyeOff size={13} />}
                      label="Hide all in group"
                      onClick={act(() =>
                        g === "draw"
                          ? symDrawings.forEach((d) => d.visible && toggleVisible(d.id))
                          : (g === "avwap" ? avwaps : regular).forEach((i) => i.enabled && toggleIndicator(i.id)),
                      )}
                    />
                  ) : (
                    <MenuItem
                      icon={<Eye size={13} />}
                      label="Show all in group"
                      onClick={act(() =>
                        g === "draw"
                          ? symDrawings.forEach((d) => !d.visible && toggleVisible(d.id))
                          : (g === "avwap" ? avwaps : regular).forEach((i) => !i.enabled && toggleIndicator(i.id)),
                      )}
                    />
                  ))}
                {g === "draw" && hasItems && (
                  <MenuItem icon={<Lock size={13} />} label="Lock all" onClick={act(() => symDrawings.forEach((d) => !d.locked && toggleLock(d.id)))} />
                )}
                {g === "draw" && hasItems && (
                  <MenuItem icon={<LockOpen size={13} />} label="Unlock all" onClick={act(() => symDrawings.forEach((d) => d.locked && toggleLock(d.id)))} />
                )}
                {hasItems && (
                  <MenuItem
                    icon={<Copy size={13} />}
                    label="Copy group summary"
                    onClick={act(() => copyText(`${grpTitle} (${grpItems.length}): ${grpItems.map((o) => o.name).join(", ")}`))}
                  />
                )}
                {(g === "avwap" || g === "draw") && hasItems && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 size={13} />}
                      danger
                      label={g === "avwap" ? "Remove all AVWAPs" : "Clear all drawings"}
                      onClick={act(() => (g === "avwap" ? removeAllAnchoredVwaps() : clearDrawings(symbol)))}
                    />
                  </>
                )}
              </>
            );
          })()}
        </TerminalMenu>
      )}
    </FloatingWindow>
  );
}
