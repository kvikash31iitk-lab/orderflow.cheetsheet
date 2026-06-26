// Shared right-click menu layer for the terminal. One set of primitives so every app surface
// (chart, panes, scanner/alert rows, indicators) opens a consistent, viewport-clamped, keyboard-
// dismissable menu instead of Chrome's native canvas menu — reusing the existing .popover / .menu-*
// design tokens. Extracted from the original FootprintContextMenu / IndicatorContextMenu idiom.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronRight } from "lucide-react";

// submenus flip to the left when the parent menu is near the right viewport edge
const OpenLeftContext = createContext(false);

/**
 * Positioned, clamped, self-dismissing menu shell. Place items (MenuItem / Submenu /
 * MenuSeparator / MenuLabel) as children. Closes on outside pointer-down, Escape, or when an
 * action calls onClose. Renders fixed at (x, y), clamped into the viewport.
 */
export function TerminalMenu({
  x,
  y,
  onClose,
  minWidth = 190,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  minWidth?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openLeft, setOpenLeft] = useState(false);

  // clamp into the viewport (flip near edges) after measuring
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
    // open submenu flyouts to the LEFT when there isn't room for one on the right
    setOpenLeft(left + r.width + 180 > window.innerWidth);
  }, [x, y]);

  // dismissal listeners attached once via a ref to the latest onClose, so frequent parent
  // re-renders (e.g. indicator recompute, live candles) can't thrash the listeners.
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

  return (
    <OpenLeftContext.Provider value={openLeft}>
      <div
        ref={ref}
        className="popover fixed z-[120] max-h-[88vh] overflow-auto py-1"
        style={{ left: pos.left, top: pos.top, minWidth }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
    </OpenLeftContext.Provider>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  active,
  danger,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean; // shows a check in the icon slot
  danger?: boolean;
  disabled?: boolean;
  hint?: string; // right-aligned keyboard/shortcut hint
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`menu-item ${danger ? "menu-item-danger" : ""} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      <span className="flex w-4 shrink-0 justify-center text-terminal-muted">
        {active ? <Check size={13} className="text-accent" /> : icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 pl-4 text-[10px] tabular-nums text-terminal-muted">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="truncate px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-terminal-muted">
      {children}
    </div>
  );
}

export function Submenu({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  const openLeft = useContext(OpenLeftContext);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="menu-item">
        <span className="flex w-4 shrink-0 justify-center text-terminal-muted">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight size={12} className="shrink-0 text-terminal-muted" />
      </button>
      {open && (
        <div
          className={`popover absolute top-0 z-[121] max-h-[70vh] min-w-[180px] overflow-auto py-1 ${
            openLeft ? "right-full mr-1" : "left-full ml-1"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Native-menu policy: KEEP the browser context menu for editable controls (inputs, textareas,
// selects, the custom JS indicator editor / contenteditable). App surfaces use openContextMenu
// (below) which bails out for these so copy/paste/spellcheck still work where users type.
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Surface-agnostic right-click state. `open(e, extra)` suppresses the native menu (except over
 * editable controls) and records the cursor position plus any surface payload; the surface renders
 * its menu when `menu` is non-null and passes `close` as onClose.
 */
export function useContextMenu<T extends object = Record<never, never>>() {
  const [menu, setMenu] = useState<({ x: number; y: number } & T) | null>(null);
  const open = (e: React.MouseEvent, extra: T) => {
    if (isEditableTarget(e.target)) return; // editable -> keep native browser menu
    e.preventDefault();
    setMenu(Object.assign({ x: e.clientX, y: e.clientY }, extra));
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}
