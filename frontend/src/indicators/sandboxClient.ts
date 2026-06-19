// Sandbox runner: drives the Web Worker. Sends one request at a time (a worker is
// single-threaded), enforces a hard timeout, and on timeout TERMINATES the hung
// worker (recreated lazily on the next run) and returns a clean "Indicator timed out".
import type { IndicatorRunner, IndicatorRunRequest, IndicatorRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, COLD_START_TIMEOUT_MS } from "./types";

export class SandboxRunner implements IndicatorRunner {
  private worker: Worker | null = null;
  private seq = 0;
  // serialize runs onto the single worker (each script must finish/terminate first)
  private chain: Promise<unknown> = Promise.resolve();
  // a freshly-created worker pays a one-time spin-up + JIT cost unrelated to the script;
  // the FIRST run gets coldTimeoutMs, then warm runs use the tight timeoutMs.
  private warmedUp = false;

  constructor(
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private coldTimeoutMs: number = COLD_START_TIMEOUT_MS,
  ) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./indicator.worker.ts", import.meta.url), { type: "module" });
    }
    return this.worker;
  }

  run(request: IndicatorRunRequest): Promise<IndicatorRunResult> {
    const result = this.chain.then(() => this.runOne(request));
    // keep the chain alive even if a run rejects (it never should — runOne resolves)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private runOne(request: IndicatorRunRequest): Promise<IndicatorRunResult> {
    return new Promise<IndicatorRunResult>((resolve) => {
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch (err) {
        resolve({ ok: false, outputs: [], error: `Worker init failed: ${String(err)}` });
        return;
      }

      const id = ++this.seq;
      let settled = false;

      const finish = (res: IndicatorRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        resolve(res);
      };

      const onMessage = (ev: MessageEvent) => {
        const data = ev.data as { id: number; result: IndicatorRunResult };
        if (!data || data.id !== id) return;
        this.warmedUp = true; // the worker answered -> it is spun up + JIT-warm now
        finish(data.result);
      };
      const onError = (ev: ErrorEvent) => {
        finish({ ok: false, outputs: [], error: ev.message || "Worker error" });
      };

      // first run on a new worker gets the generous cold budget; warm runs the tight one.
      const budget = this.warmedUp ? this.timeoutMs : this.coldTimeoutMs;
      const timer = setTimeout(() => {
        // hung script: kill the worker so the loop can't keep running; recreated next run.
        this.terminate();
        finish({ ok: false, outputs: [], error: "Indicator timed out" });
      }, budget);

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);

      try {
        worker.postMessage({ id, request });
      } catch (err) {
        finish({ ok: false, outputs: [], error: `postMessage failed: ${String(err)}` });
      }
    });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.warmedUp = false; // the next worker will be cold again
  }
}
