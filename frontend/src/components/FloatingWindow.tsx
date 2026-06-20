// Reusable draggable + resizable floating window — the workspace primitive that
// replaces the centered modal cards. Floating windows have NO dimming backdrop and
// no click-outside-to-close (they behave like internal desktop windows): close via
// the × button. Position/size persist per `id` in the store (localStorage), are
// clamped back into view on open / viewport resize, and the window comes to front
// on focus via a shared z-index counter.
//
// Mount these high in the tree (App/Header/Dashboard top level) — NOT inside a
// `.panel` (its backdrop-blur creates a containing block that would trap position:fixed).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore, type WindowRect } from "../store/useStore";

export interface DefaultRect {
  w: number;
  h: number;
  x?: number; // omitted -> horizontally centered
  y?: number; // omitted -> near the top third
}

interface FloatingWindowProps {
  id: string;
  title: string;
  open: boolean;
  onClose: () => void;
  defaultRect: DefaultRect;
  minW?: number;
  minH?: number;
  children: ReactNode;
  headerExtra?: ReactNode;
  bodyClassName?: string;
  // opt-in dismissal (default off; most workspace windows close only via ×):
  closeOnOutside?: boolean; // pointer-down anywhere outside the window closes it
  closeOnEscape?: boolean; // Escape closes it (ignored while editing a field is fine)
}

// shared focus counter; windows replace the old z-50 modals so we start at 50.
let TOP_Z = 50;
function nextZ(): number {
  return ++TOP_Z;
}

function clampRect(r: WindowRect): WindowRect {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(r.w, vw);
  const h = Math.min(r.h, vh);
  const x = Math.max(0, Math.min(r.x, vw - 80)); // keep >=80px reachable
  const y = Math.max(0, Math.min(r.y, vh - 40)); // keep the title bar reachable
  return { x, y, w, h };
}

function resolveInitial(stored: WindowRect | undefined, def: DefaultRect): WindowRect {
  if (stored) return clampRect(stored);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const x = def.x ?? Math.max(12, (vw - def.w) / 2);
  const y = def.y ?? Math.max(56, vh / 3 - def.h / 3);
  return clampRect({ x, y, w: def.w, h: def.h });
}

type ResizeDir = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };

export default function FloatingWindow({
  id,
  title,
  open,
  onClose,
  defaultRect,
  minW = 220,
  minH = 150,
  children,
  headerExtra,
  bodyClassName,
  closeOnOutside = false,
  closeOnEscape = false,
}: FloatingWindowProps) {
  const storedRect = useStore((s) => s.windows[id]);
  const setWindowRect = useStore((s) => s.setWindowRect);

  const [rect, setRect] = useState<WindowRect>(() => resolveInitial(storedRect, defaultRect));
  const [z, setZ] = useState<number>(() => nextZ());
  const winRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);
  const resizeRef = useRef<{ start: WindowRect; px: number; py: number; dir: ResizeDir } | null>(null);

  const focus = useCallback(() => setZ(nextZ()), []);

  // re-clamp + come to front each time the window opens
  useLayoutEffect(() => {
    if (open) {
      setRect(resolveInitial(rectRef.current ?? storedRect, defaultRect));
      setZ(nextZ());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // keep the window inside the viewport when the browser resizes
  useEffect(() => {
    if (!open) return;
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // opt-in dismissal: pointer-down outside the window, and/or Escape. A ref to the
  // latest onClose keeps the listener attached across frequent parent re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open || (!closeOnOutside && !closeOnEscape)) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!closeOnOutside) return;
      const el = winRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape") onCloseRef.current();
    };
    // attach synchronously: the click that OPENED the window already finished its
    // pointerdown before this effect runs (open is via a React click handler), so this
    // can't self-close — and there is no setTimeout race for an immediate outside click.
    if (closeOnOutside) document.addEventListener("pointerdown", onPointerDown, true);
    if (closeOnEscape) document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closeOnOutside, closeOnEscape]);

  const commit = useCallback(
    (r: WindowRect) => {
      setWindowRect(id, r);
    },
    [id, setWindowRect],
  );

  // ---- drag (title bar) ----
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    e.preventDefault();
    focus();
    dragRef.current = { ox: rectRef.current.x, oy: rectRef.current.y, px: e.clientX, py: e.clientY };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable */
    }
  };
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // update the ref synchronously so commit() on pointerup never reads a pre-flush rect
    const next = clampRect({ ...rectRef.current, x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
    rectRef.current = next;
    setRect(next);
  };
  const endHeaderDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    commit(rectRef.current);
  };

  // ---- resize (edges + corners) ----
  const startResize = (e: React.PointerEvent, dir: ResizeDir) => {
    e.preventDefault();
    e.stopPropagation();
    focus();
    resizeRef.current = { start: { ...rectRef.current }, px: e.clientX, py: e.clientY, dir };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable */
    }
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const rz = resizeRef.current;
    if (!rz) return;
    const dx = e.clientX - rz.px;
    const dy = e.clientY - rz.py;
    let { x, y, w, h } = rz.start;
    if (rz.dir.r) w = rz.start.w + dx;
    if (rz.dir.b) h = rz.start.h + dy;
    if (rz.dir.l) {
      w = rz.start.w - dx;
      x = rz.start.x + dx;
      if (w < minW) {
        x = rz.start.x + rz.start.w - minW;
        w = minW;
      }
    }
    if (rz.dir.t) {
      h = rz.start.h - dy;
      y = rz.start.y + dy;
      if (h < minH) {
        y = rz.start.y + rz.start.h - minH;
        h = minH;
      }
    }
    w = Math.max(minW, w);
    h = Math.max(minH, h);
    const next = clampRect({ x, y, w, h });
    rectRef.current = next;
    setRect(next);
  };
  const endResize = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    commit(rectRef.current);
  };

  if (!open) return null;

  const edge = "absolute select-none touch-none";
  return (
    <div
      ref={winRef}
      className="fixed flex flex-col overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel shadow-2xl shadow-black/50"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
      onPointerDown={focus}
      role="dialog"
      aria-label={title}
    >
      {/* title bar (drag handle) */}
      <div
        className="flex shrink-0 cursor-move items-center justify-between gap-2 border-b border-terminal-border bg-terminal-bg/40 px-3 py-1.5"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
      >
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-terminal-muted">
          {title}
        </span>
        <div className="flex items-center gap-2" data-no-drag>
          {headerExtra}
          <button
            onClick={onClose}
            title="Close"
            className="text-lg leading-none text-terminal-muted hover:text-terminal-text"
          >
            ×
          </button>
        </div>
      </div>

      {/* body */}
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName ?? "p-3"}`}>{children}</div>

      {/* resize handles: 4 edges + 4 corners */}
      <div className={`${edge} left-2 right-2 top-0 h-1.5 cursor-ns-resize`} onPointerDown={(e) => startResize(e, { t: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} left-2 right-2 bottom-0 h-1.5 cursor-ns-resize`} onPointerDown={(e) => startResize(e, { b: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} top-2 bottom-2 left-0 w-1.5 cursor-ew-resize`} onPointerDown={(e) => startResize(e, { l: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} top-2 bottom-2 right-0 w-1.5 cursor-ew-resize`} onPointerDown={(e) => startResize(e, { r: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} left-0 top-0 h-3 w-3 cursor-nwse-resize`} onPointerDown={(e) => startResize(e, { l: true, t: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} right-0 top-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={(e) => startResize(e, { r: true, t: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className={`${edge} left-0 bottom-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={(e) => startResize(e, { l: true, b: true })} onPointerMove={onResizePointerMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div
        className={`${edge} right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize`}
        onPointerDown={(e) => startResize(e, { r: true, b: true })}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        title="Resize"
      >
        <span className="pointer-events-none absolute bottom-0.5 right-0.5 text-terminal-muted">⋰</span>
      </div>
    </div>
  );
}
