// TradingView-style active-indicator legend, pinned to the chart pane top-left. One
// compact row per applied indicator with inline controls (hide/show, settings, source,
// remove, three-dot menu). Enabled+visible rows read strong; disabled or
// hidden-on-this-interval rows are dimmed. The container is pointer-events-none so it
// never blocks chart drags; only the rows themselves are interactive.
import { useState } from "react";
import { Braces, Eye, EyeOff, MoreHorizontal, Settings, Trash2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { isIndicatorVisibleOnTimeframe } from "../indicators/visibility";
import IndicatorContextMenu from "./IndicatorContextMenu";

function IconBtn({ title, onClick, children, danger }: { title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-4 w-4 items-center justify-center rounded hover:bg-terminal-border/40 ${
        danger ? "text-terminal-muted hover:text-flow-sellHi" : "text-terminal-muted hover:text-terminal-text"
      }`}
    >
      {children}
    </button>
  );
}

export default function IndicatorLegend() {
  const indicators = useStore((s) => s.indicators);
  const errors = useStore((s) => s.indicatorErrors);
  const timeframe = useStore((s) => s.timeframe);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const setSettingsIndicatorId = useStore((s) => s.setSettingsIndicatorId);
  const setSourceIndicatorId = useStore((s) => s.setSourceIndicatorId);
  const selectIndicator = useStore((s) => s.selectIndicator);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  if (indicators.length === 0) return null;

  return (
    <>
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex max-w-[60%] flex-col gap-0.5">
        {indicators.map((ind) => {
          const err = errors[ind.id] ?? ind.lastError ?? null;
          const hiddenInterval = !isIndicatorVisibleOnTimeframe(ind, timeframe);
          const active = ind.enabled && !hiddenInterval;
          const dimmed = !active;
          const dotColor = err ? "bg-flow-sellHi" : active ? "bg-flow-buyHi" : "bg-terminal-muted";
          const statusTitle = err
            ? `Error: ${err}`
            : !ind.enabled
              ? "Hidden"
              : hiddenInterval
                ? "Hidden on this interval"
                : ind.name;
          return (
            <div
              key={ind.id}
              data-testid="indicator-legend-row"
              data-indicator-name={ind.name}
              className={`pointer-events-auto flex items-center gap-1.5 rounded border border-transparent bg-terminal-panel/70 py-0.5 pl-1.5 pr-1 backdrop-blur-sm hover:border-terminal-border ${
                dimmed ? "opacity-50" : ""
              }`}
              onClick={() => selectIndicator(ind.kind === "anchored-vwap" ? ind.id : null)}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} title={statusTitle} />
              <span
                className={`max-w-[200px] truncate text-[11px] font-semibold ${active ? "text-terminal-text" : "text-terminal-muted"} ${
                  hiddenInterval ? "line-through" : ""
                }`}
                title={statusTitle}
              >
                {ind.name}
              </span>
              <div className="flex items-center gap-0.5">
                <IconBtn
                  title={ind.enabled ? "Hide" : "Show"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleIndicator(ind.id);
                  }}
                >
                  {ind.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </IconBtn>
                <IconBtn
                  title="Settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettingsIndicatorId(ind.id);
                  }}
                >
                  <Settings size={12} />
                </IconBtn>
                <IconBtn
                  title="Source code"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSourceIndicatorId(ind.id);
                  }}
                >
                  <Braces size={12} />
                </IconBtn>
                <IconBtn
                  title="Remove"
                  danger
                  onClick={(e) => {
                    e.stopPropagation();
                    removeIndicator(ind.id);
                  }}
                >
                  <Trash2 size={12} />
                </IconBtn>
                <IconBtn
                  title="More"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu((m) => (m && m.id === ind.id ? null : { id: ind.id, x: r.left, y: r.bottom + 2 }));
                  }}
                >
                  <MoreHorizontal size={12} />
                </IconBtn>
              </div>
            </div>
          );
        })}
      </div>
      {menu && (
        <IndicatorContextMenu indicatorId={menu.id} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
