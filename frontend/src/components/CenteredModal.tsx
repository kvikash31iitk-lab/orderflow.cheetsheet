// Centered modal with a dimming backdrop — used for the TradingView-style indicator
// Settings and Source-code dialogs (distinct from FloatingWindow, which is a backdrop-
// less workspace window). Backdrop click + Escape call onClose; the card stops
// propagation. Renders above floating windows (z-[100]).
import { useEffect, useRef, type ReactNode } from "react";

export default function CenteredModal({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = "w-[520px]",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div
        className={`flex max-h-[88vh] ${widthClass} max-w-[94vw] flex-col overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel shadow-2xl shadow-black/60`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-terminal-border bg-terminal-bg/40 px-4 py-2.5">
          <span className="truncate text-sm font-semibold text-terminal-text">{title}</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="-mr-1 rounded p-1 text-terminal-muted hover:bg-terminal-border hover:text-terminal-text"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-terminal-border bg-terminal-bg/40 px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
