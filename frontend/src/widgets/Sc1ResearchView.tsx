import { useState } from "react";
import Sc1ResearchLab from "./Sc1ResearchLab";
import Sc1LargeJob from "./Sc1LargeJob";

type Mode = "quick" | "large_run" | "walk_forward";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "quick", label: "Recent Quick Run", hint: "fast, recent window, 5s orderflow" },
  { id: "large_run", label: "Large Dataset Job", hint: "date range, async, paginated" },
  { id: "walk_forward", label: "Walk-Forward Optimization", hint: "train/val/test, out-of-sample" },
];

/** Top-level SC1 Research surface: a mode selector over the recent quick lab and the
 *  large-dataset job workflows (built for 5-year GC scale). */
export default function Sc1ResearchView() {
  const [mode, setMode] = useState<Mode>("quick");
  return (
    <div className="flex h-full flex-col bg-terminal-bg">
      <div className="flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-terminal-muted">SC1 Mode</span>
        {MODES.map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} title={m.hint}
            className={`rounded px-2.5 py-1 text-xs font-medium ${mode === m.id ? "bg-flow-delta text-white" : "text-terminal-muted hover:bg-terminal-border"}`}>
            {m.label}
          </button>
        ))}
        <span className="ml-2 hidden text-[10px] text-terminal-muted md:inline">{MODES.find((m) => m.id === mode)?.hint}</span>
      </div>
      {mode === "quick" ? (
        <div className="min-h-0 flex-1">
          <Sc1ResearchLab />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* key forces a full remount on mode switch -> tears down the previous job's poller + state */}
          <Sc1LargeJob key={mode} mode={mode} />
        </div>
      )}
    </div>
  );
}
