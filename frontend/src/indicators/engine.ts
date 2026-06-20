// Indicator engine: the only thing the store calls. It selects a runner for the
// current execution mode and runs every enabled indicator, aggregating normalized
// outputs + per-indicator errors. Swapping the execution backend (worker / direct /
// future backend) happens HERE only - the store + charts are untouched.
import { DirectRunner } from "./directRunner";
import { SandboxRunner } from "./sandboxClient";
import { MAX_CANDLES, MAX_OUTPUTS } from "./types";
import type {
  IndicatorDataContext,
  IndicatorExecutionMode,
  IndicatorInstance,
  IndicatorOutput,
  IndicatorRunner,
} from "./types";
import type { FootprintCandle } from "../types/orderflow";

let directRunner: DirectRunner | null = null;
let sandboxRunner: SandboxRunner | null = null;

function getRunner(mode: IndicatorExecutionMode): IndicatorRunner | null {
  if (mode === "direct") {
    directRunner = directRunner || new DirectRunner();
    return directRunner;
  }
  if (mode === "sandbox") {
    sandboxRunner = sandboxRunner || new SandboxRunner();
    return sandboxRunner;
  }
  return null; // disabled
}

export interface IndicatorRunSummary {
  outputs: IndicatorOutput[];
  errors: Record<string, string | null>;
}

export async function runIndicators(
  mode: IndicatorExecutionMode,
  indicators: IndicatorInstance[],
  candles: FootprintCandle[],
  symbol: string,
  timeframe: string,
  dataContext?: IndicatorDataContext,
): Promise<IndicatorRunSummary> {
  const errors: Record<string, string | null> = {};

  if (mode === "disabled") {
    for (const ind of indicators) errors[ind.id] = null;
    return { outputs: [], errors };
  }

  const runner = getRunner(mode);
  if (!runner) return { outputs: [], errors };

  const clamped = candles.length > MAX_CANDLES ? candles.slice(-MAX_CANDLES) : candles;
  const outputs: IndicatorOutput[] = [];

  // sequential: keeps the single sandbox worker handling one script at a time
  for (const ind of indicators) {
    if (!ind.enabled) {
      errors[ind.id] = null;
      continue;
    }
    let res;
    try {
      res = await runner.run({
        indicator: ind,
        candles: clamped,
        symbol,
        timeframe,
        maxOutputs: MAX_OUTPUTS,
        dataContext,
      });
    } catch (err) {
      errors[ind.id] = err instanceof Error ? err.message : String(err);
      continue;
    }
    errors[ind.id] = res.ok ? null : res.error || "Unknown error";
    if (res.ok) {
      for (const o of res.outputs) {
        if (outputs.length >= MAX_OUTPUTS) break;
        outputs.push(o);
      }
    }
  }

  return { outputs, errors };
}

// Free the sandbox worker (e.g. when switching away from sandbox mode).
export function disposeSandbox(): void {
  if (sandboxRunner) {
    sandboxRunner.terminate();
    sandboxRunner = null;
  }
}
