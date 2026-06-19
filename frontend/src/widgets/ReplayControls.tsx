import { useState } from "react";
import { api } from "../api/rest";
import { wsClient } from "../api/ws";
import { useStore } from "../store/useStore";

const SPEEDS = [1, 2, 5, 10, 50];

export default function ReplayControls() {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const replay = useStore((s) => s.replay);
  const [speed, setSpeed] = useState(5);
  const [loaded, setLoaded] = useState(0);

  const load = async () => {
    const end = Date.now();
    const start = end - 2 * 60 * 60 * 1000; // last 2h of recorded ticks
    // switch this client onto the isolated replay feed so it receives replay candles
    wsClient.setReplayMode(true);
    const r = (await api.replayLoad({ symbol, start, end, timeframe })) as { ticks: number };
    setLoaded(r.ticks);
  };

  const play = async () => {
    wsClient.setReplayMode(true);
    await api.replayPlay(speed);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button onClick={load} className="rounded bg-terminal-border px-2 py-1 hover:bg-terminal-border/70">
        Load 2h
      </button>
      <span className="text-terminal-muted">{loaded ? `${loaded.toLocaleString()} ticks` : ""}</span>
      <div className="flex items-center gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`rounded px-1.5 py-0.5 ${speed === s ? "bg-flow-delta text-white" : "bg-terminal-border"}`}
          >
            {s}x
          </button>
        ))}
      </div>
      <button onClick={play} className="rounded bg-flow-buy px-2 py-1 text-white">
        ▶
      </button>
      <button onClick={() => api.replayPause()} className="rounded bg-terminal-border px-2 py-1">
        ❚❚
      </button>
      <button onClick={() => api.replayStep()} className="rounded bg-terminal-border px-2 py-1">
        ⏭ step
      </button>
      <button onClick={() => api.replayStop()} className="rounded bg-flow-sell px-2 py-1 text-white">
        ■
      </button>
      {replay && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-28 overflow-hidden rounded bg-terminal-border">
            <div className="h-full bg-flow-delta" style={{ width: `${(replay.progress * 100).toFixed(1)}%` }} />
          </div>
          <span className="text-terminal-muted">
            {replay.index}/{replay.total}
          </span>
        </div>
      )}
    </div>
  );
}
