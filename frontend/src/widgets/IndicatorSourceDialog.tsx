// Source-code view/editor for one indicator instance. Editing affects ONLY this
// instance (built-in example templates are never mutated). Save validates metadata via
// parseIndicatorMeta and updates the instance (which recomputes). Cancel discards.
// The textarea is uncontrolled (defaultValue + ref) so editing the ~73k SC1 V4 script
// never re-renders a 73k controlled value per keystroke.
import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import CenteredModal from "../components/CenteredModal";
import { parseIndicatorMeta } from "../indicators/runtime";

export default function IndicatorSourceDialog() {
  const id = useStore((s) => s.sourceIndicatorId);
  const ind = useStore((s) => s.indicators.find((i) => i.id === s.sourceIndicatorId));
  const close = useStore((s) => s.setSourceIndicatorId);
  const updateIndicator = useStore((s) => s.updateIndicator);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [meta, setMeta] = useState<{ name: string; error?: string }>(() =>
    ind ? parseIndicatorMeta(ind.script) : { name: "" },
  );

  if (!id || !ind) return null;

  const onClose = () => close(null);
  const save = () => {
    const script = ref.current?.value ?? ind.script;
    const m = parseIndicatorMeta(script);
    if (m.error) {
      setMeta(m);
      return;
    }
    updateIndicator(ind.id, { script });
    onClose();
  };

  return (
    <CenteredModal
      open
      onClose={onClose}
      title={`Source code — ${ind.name}`}
      widthClass="w-[760px]"
      footer={
        <>
          <span className={`mr-auto truncate text-[11px] ${meta.error ? "text-flow-sellHi" : "text-terminal-muted"}`}>
            {meta.error ? meta.error : `${meta.name} · parses OK`}
          </span>
          <button onClick={onClose} className="rounded border border-terminal-border px-3 py-1 text-xs text-terminal-text hover:bg-terminal-border">
            Cancel
          </button>
          <button onClick={save} disabled={!!meta.error} className="rounded bg-flow-delta px-4 py-1 text-xs font-semibold text-white disabled:opacity-40">
            Save
          </button>
        </>
      }
    >
      <div className="p-3">
        <textarea
          ref={ref}
          defaultValue={ind.script}
          spellCheck={false}
          onChange={(e) => setMeta(parseIndicatorMeta(e.target.value))}
          className="h-[58vh] w-full resize-none rounded border border-terminal-border bg-terminal-bg p-2 font-mono text-[11px] leading-relaxed text-terminal-text"
        />
      </div>
    </CenteredModal>
  );
}
