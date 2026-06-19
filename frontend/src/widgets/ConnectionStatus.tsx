import { useStore } from "../store/useStore";

export default function ConnectionStatus() {
  const status = useStore((s) => s.status);
  const connected = useStore((s) => s.connected);
  const selectedSource = useStore((s) => s.source);

  const source = status?.source ?? "none";
  const state = connected ? status?.state ?? "connected" : "disconnected";
  const dot =
    state === "connected" ? "bg-flow-buyHi" : state === "reconnecting" ? "bg-flow-exhaustion" : "bg-flow-sellHi";
  // Show the USER-SELECTED source, not the tick-driven merged primary: both feeds
  // stream concurrently, so status.source is always "truedata" while NIFTY ticks —
  // even when the user is viewing a DataBento symbol. For TrueData, still surface
  // the simulator fallback (market closed / no creds) honestly.
  const sourceLabel =
    selectedSource === "databento"
      ? "DataBento"
      : selectedSource === "truedata"
      ? (source === "simulator" ? "Simulator" : "TrueData")
      : "—";

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot} ${state === "connected" ? "animate-pulse" : ""}`} />
        <span className="capitalize">{state}</span>
      </div>
      <span className="text-terminal-muted">·</span>
      <span title="data source">{sourceLabel}</span>
      <span className="text-terminal-muted">·</span>
      <span title="ticks received">{status?.tickCount?.toLocaleString() ?? 0} ticks</span>
      <span className="text-terminal-muted">·</span>
      <span className={status?.pgEnabled ? "text-flow-buyHi" : "text-terminal-muted"} title="PostgreSQL">PG</span>
      <span className={status?.redisEnabled ? "text-flow-buyHi" : "text-terminal-muted"} title="Redis">RD</span>
    </div>
  );
}
