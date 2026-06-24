import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { formatIstTime } from "../lib/time";

const SEV: Record<string, string> = {
  high: "border-l-flow-sellHi text-flow-sellHi",
  warning: "border-l-flow-exhaustion text-flow-exhaustion",
  info: "border-l-flow-delta text-flow-delta",
};

// short beep via WebAudio so no asset file is needed
function beep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.05, ctx.currentTime);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
    o.stop(ctx.currentTime + 0.2);
  } catch {
    /* autoplay restrictions — ignore */
  }
}

const DATABENTO_SYMBOLS = ["6E.V.0", "GC.V.0", "6E.v.0", "GC.v.0"];

export default function AlertsPanel() {
  const alerts = useStore((s) => s.alerts);
  const source = useStore((s) => s.source);
  const lastTs = useRef(0);
  const primed = useRef(false);

  const filteredAlerts = alerts.filter((a) => {
    const isDb = DATABENTO_SYMBOLS.includes(a.symbol.toUpperCase());
    return source === "databento" ? isDb : !isDb;
  });

  useEffect(() => {
    const latest = filteredAlerts[0];
    if (!latest) return;
    // first population (incl. the DB-seeded history) is treated as already-seen
    // so a stale historical alert can't beep on page load
    if (!primed.current) {
      primed.current = true;
      lastTs.current = latest.ts;
      return;
    }
    if (latest.ts !== lastTs.current) {
      lastTs.current = latest.ts;
      if (latest.severity === "high") beep();
    }
  }, [filteredAlerts]);

  return (
    <div className="h-full overflow-auto">
      {filteredAlerts.length === 0 && <div className="px-2 py-1 text-xs text-terminal-muted">no alerts yet</div>}
      {filteredAlerts.map((a, i) => (
        <div key={`${a.ts}-${i}`} className={`border-l-2 ${SEV[a.severity] ?? SEV.info} bg-terminal-elevated px-2 py-1`}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold">{a.type}</span>
            <span className="text-terminal-muted">
              {a.symbol} {a.timeframe}
            </span>
          </div>
          <div className="text-[11px] text-terminal-text">{a.message}</div>
          <div className="text-[10px] tabular-nums text-terminal-muted">{formatIstTime(a.ts, true)} IST</div>
        </div>
      ))}
    </div>
  );
}
