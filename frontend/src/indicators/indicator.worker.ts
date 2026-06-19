// Sandboxed indicator worker. Runs in a Web Worker (no DOM / window / localStorage),
// receives a run request, executes the script via the shared runtime, and posts back
// the normalized result. The client (SandboxRunner) enforces the timeout and will
// terminate this worker if a script hangs.
import { executeIndicatorScript } from "./runtime";
import type { IndicatorRunRequest, IndicatorRunResult } from "./types";

// `self` is typed as Window by the DOM lib (no WebWorker lib in tsconfig); cast to a
// minimal worker-shaped structural type so this typechecks without lib changes.
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = (ev: MessageEvent) => {
  const data = ev.data as { id: number; request: IndicatorRunRequest };
  if (!data || typeof data.id !== "number") return;
  let result: IndicatorRunResult;
  try {
    result = executeIndicatorScript(data.request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { ok: false, outputs: [], error: msg };
  }
  ctx.postMessage({ id: data.id, result });
};
