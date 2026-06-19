import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "../store/useStore";

export default function BlockSizeModal() {
  const open = useStore((s) => s.blockSizeModalOpen);
  const setOpen = useStore((s) => s.setBlockSizeModalOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [val, setVal] = useState(String(settings.tickMultiplier));
  const inputRef = useRef<HTMLInputElement>(null);

  // seed the field with the current block size and autofocus/select on open
  useEffect(() => {
    if (!open) return;
    setVal(String(settings.tickMultiplier));
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
    return () => clearTimeout(t);
  }, [open, settings.tickMultiplier]);

  // Escape (or ';' again -> toggle close) dismisses without applying
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === ";") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const num = parseInt(val, 10);
    if (!Number.isNaN(num) && num >= 1) setSettings({ tickMultiplier: num });
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex w-[320px] flex-col items-center rounded-lg border border-terminal-border bg-terminal-panel p-5 shadow-2xl shadow-black/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mb-3 select-none text-xs font-semibold uppercase tracking-wider text-terminal-muted">
          Change Orderflow Block Size
        </span>
        <form onSubmit={apply} className="w-full">
          <input
            ref={inputRef}
            type="number"
            min="1"
            step="1"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="w-full rounded border border-terminal-border bg-terminal-bg py-3 text-center font-mono text-4xl font-bold text-terminal-text shadow-inner focus:border-flow-delta focus:outline-none"
          />
          <button type="submit" className="hidden" />
        </form>
        <span className="mt-3 select-none text-[10px] text-terminal-muted">
          Press{" "}
          <kbd className="rounded border border-terminal-border bg-terminal-bg px-1 py-0.5">Enter</kbd> to apply ·{" "}
          <kbd className="rounded border border-terminal-border bg-terminal-bg px-1 py-0.5">Esc</kbd> to cancel
        </span>
      </div>
    </div>
  );
}
