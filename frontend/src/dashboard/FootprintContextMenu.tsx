// GoCharting/TradingView-style right-click menu for the footprint chart area. Anchored at
// the cursor, clamped into the viewport, closes on outside pointer-down / Escape / action.
// Reuses the IndicatorContextMenu idiom (compact rows, theme tokens, lucide icons).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Clock, Columns3, Copy, Grid3x3, Layers, Maximize2, RotateCcw, Ruler, Settings } from "lucide-react";
import { useStore } from "../store/useStore";
import type { FootprintColorMatrix, FootprintColumns, FootprintSettings } from "../types/orderflow";
import { FOOTPRINT_PRESETS } from "./footprintPresets";

const menuCls =
  "min-w-[190px] overflow-auto rounded-md border border-terminal-border-strong bg-terminal-elevated py-1 shadow-xl shadow-black/40";
const rowCls = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs";

function Item({
  icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`${rowCls} ${danger ? "text-flow-sellHi hover:bg-flow-sellHi/10" : "text-terminal-text hover:bg-terminal-border/60"}`}
    >
      <span className="flex w-4 shrink-0 justify-center text-terminal-muted">
        {active ? <Check size={13} className="text-flow-delta" /> : icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

function Submenu({ icon, label, openLeft, children }: { icon: ReactNode; label: string; openLeft: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className={`${rowCls} text-terminal-text hover:bg-terminal-border/60`}>
        <span className="flex w-4 shrink-0 justify-center text-terminal-muted">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight size={12} className="shrink-0 text-terminal-muted" />
      </button>
      {open && (
        <div className={`absolute top-0 z-[121] max-h-[70vh] ${openLeft ? "right-full mr-1" : "left-full ml-1"} ${menuCls}`}>
          {children}
        </div>
      )}
    </div>
  );
}

const Divider = () => <div className="my-1 h-px bg-terminal-border" />;

const TOGGLES: { key: keyof FootprintSettings; label: string }[] = [
  { key: "showCluster", label: "Show Cluster" },
  { key: "autoFontSize", label: "Auto Fontsize" },
  { key: "showProfile", label: "Show Profile" },
  { key: "showImbalances", label: "Show Imbalances" },
  { key: "showPoc", label: "Show POC" },
  { key: "extendPoc", label: "Extend POC" },
  { key: "showVwap", label: "Show VWAP" },
  { key: "showSdBands", label: "Show SD Bands" },
];

export default function FootprintContextMenu({
  x,
  y,
  price,
  time,
  onResetView,
  onClose,
}: {
  x: number;
  y: number;
  price?: number | null;
  time?: number | null;
  onResetView?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openLeft, setOpenLeft] = useState(false);

  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const resetSettings = useStore((s) => s.resetSettings);
  const setFootprintMode = useStore((s) => s.setFootprintMode);
  const setFootprintSettingsOpen = useStore((s) => s.setFootprintSettingsOpen);
  const setBlockSizeModalOpen = useStore((s) => s.setBlockSizeModalOpen);

  // clamp into the viewport (flip near edges); flyouts open left when near the right edge
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
    setOpenLeft(left + r.width + 170 > window.innerWidth);
  }, [x, y]);

  // dismissal listeners attached once via a ref to the latest onClose
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const copy = (text: string) =>
    act(() => {
      // writeText() rejects ASYNCHRONOUSLY (lost focus / permission / insecure origin); catch the
      // promise too so a failed copy can never surface as an unhandled rejection in the console.
      try {
        void navigator.clipboard?.writeText(text)?.catch(() => {});
      } catch {
        /* clipboard API unavailable */
      }
    });
  const timeStr =
    time != null
      ? new Date(time).toLocaleString("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "";
  const columns: FootprintColumns = settings.clusterColumns;
  const matrix: FootprintColorMatrix = settings.colorMatrix;

  return (
    <div
      ref={ref}
      className={`fixed z-[120] max-h-[88vh] ${menuCls}`}
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item icon={<Settings size={13} />} label="Edit Footprint Settings…" onClick={act(() => setFootprintSettingsOpen(true))} />
      {price != null && <Item icon={<Copy size={13} />} label={`Copy price  ${price.toFixed(2)}`} onClick={copy(price.toFixed(2))} />}
      {time != null && <Item icon={<Clock size={13} />} label={`Copy time  ${timeStr}`} onClick={copy(timeStr)} />}
      {onResetView && <Item icon={<Maximize2 size={13} />} label="Reset chart view" onClick={act(() => onResetView())} />}
      <Divider />
      <Submenu icon={<Layers size={13} />} label="Apply Preset" openLeft={openLeft}>
        {FOOTPRINT_PRESETS.map((p) => (
          <Item
            key={p.name}
            label={p.name}
            onClick={act(() => {
              setSettings(p.settings);
              if (p.mode) setFootprintMode(p.mode);
            })}
          />
        ))}
      </Submenu>
      <Submenu icon={<Columns3 size={13} />} label="Columns" openLeft={openLeft}>
        <Item label="Single" active={columns === "single"} onClick={act(() => setSettings({ clusterColumns: "single" }))} />
        <Item label="Double" active={columns === "double"} onClick={act(() => setSettings({ clusterColumns: "double" }))} />
      </Submenu>
      <Submenu icon={<Grid3x3 size={13} />} label="Color Matrix" openLeft={openLeft}>
        <Item label="Default" active={matrix === "default"} onClick={act(() => setSettings({ colorMatrix: "default" }))} />
        <Item label="Volume" active={matrix === "volume"} onClick={act(() => setSettings({ colorMatrix: "volume" }))} />
        <Item label="Delta" active={matrix === "delta"} onClick={act(() => setSettings({ colorMatrix: "delta" }))} />
      </Submenu>
      <Divider />
      {TOGGLES.map((t) => (
        <Item
          key={t.key}
          label={t.label}
          active={settings[t.key] as boolean}
          onClick={() => setSettings({ [t.key]: !(settings[t.key] as boolean) } as Partial<FootprintSettings>)}
        />
      ))}
      <Divider />
      <Item icon={<Ruler size={13} />} label="Block Size…" onClick={act(() => setBlockSizeModalOpen(true))} />
      <Item icon={<RotateCcw size={13} />} label="Reset Footprint Settings" danger onClick={act(() => resetSettings())} />
    </div>
  );
}
