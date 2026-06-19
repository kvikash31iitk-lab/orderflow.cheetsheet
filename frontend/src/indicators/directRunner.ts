// Direct runner: executes the script synchronously on the MAIN thread.
// NOT sandboxed and NOT interruptible — an infinite loop here will hang the tab.
// Use only for trusted scripts; SandboxRunner is the isolated path.
import type { IndicatorRunner, IndicatorRunRequest, IndicatorRunResult } from "./types";
import { executeIndicatorScript } from "./runtime";

export class DirectRunner implements IndicatorRunner {
  run(request: IndicatorRunRequest): Promise<IndicatorRunResult> {
    try {
      return Promise.resolve(executeIndicatorScript(request));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ ok: false, outputs: [], error: msg });
    }
  }
}
