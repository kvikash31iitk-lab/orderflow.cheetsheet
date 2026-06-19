import type { ServerMessage } from "../types/orderflow";
import { consolidatedRowSize } from "../lib/rowsize";
import { snapshotRequestForMode } from "../lib/limits";
import { useStore } from "../store/useStore";

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${location.hostname}:8000`;

class WSClient {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private heartbeat?: number;
  private started = false;
  private replayMode = false; // which feed this client is subscribed to (live vs replay)

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${WS_URL}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      useStore.getState().setConnected(true);
      this.resubscribe();
      this.heartbeat = window.setInterval(() => this.send({ action: "ping" }), 10000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        useStore.getState().ingest(msg);
        // a replay-exit frame means the replay ended -> switch back to the live feed
        if (msg.type === "replay" && msg.data.exit) {
          this.setReplayMode(false);
        }
      } catch {
        /* ignore malformed frame */
      }
    };

    ws.onclose = () => {
      useStore.getState().setConnected(false);
      window.clearInterval(this.heartbeat);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };

    ws.onerror = () => ws.close();
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  resubscribe() {
    const { symbol, timeframe, consolidation, chartDisplayMode } = useStore.getState();
    const { limit, cells } = snapshotRequestForMode(chartDisplayMode);
    this.send({
      action: "subscribe", symbol, timeframe, replay: this.replayMode,
      rowSize: consolidatedRowSize(symbol, consolidation), limit, cells,
    });
  }

  subscribe(symbol: string, timeframe: string) {
    const { consolidation, chartDisplayMode } = useStore.getState();
    const { limit, cells } = snapshotRequestForMode(chartDisplayMode);
    this.send({
      action: "subscribe", symbol, timeframe, replay: this.replayMode,
      rowSize: consolidatedRowSize(symbol, consolidation), limit, cells,
    });
  }

  // switch the live/replay feed; re-subscribes with the same symbol/timeframe.
  // replay:false here is what resumes live updates after a replay ends.
  setReplayMode(replay: boolean) {
    if (this.replayMode === replay) return;
    this.replayMode = replay;
    this.resubscribe();
  }

  get isReplay() {
    return this.replayMode;
  }
}

export const wsClient = new WSClient();
