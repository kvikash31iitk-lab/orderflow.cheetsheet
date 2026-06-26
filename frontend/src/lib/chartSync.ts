// Cross-panel chart sync registry. The three dashboard charts live in separate
// React components; they register here so the MAIN footprint chart can drive the
// sub-panels' visible time range (Task 2) and crosshair (Task 3) one-way.
import type {
  IChartApi,
  ISeriesApi,
  LogicalRange,
  MouseEventParams,
  SeriesType,
  Time,
} from "lightweight-charts";

export type ChartId = "main" | "histogram" | "cumdelta" | "barstats";

export interface ChartEntry {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  // value of this panel's series at a given time (for the synced horizontal crosshair)
  valueAt?: (time: number) => number | undefined;
}

const charts = new Map<ChartId, ChartEntry>();
let wiredMainChart: IChartApi | null = null;
let rangeHandler: ((range: LogicalRange | null) => void) | null = null;
let crosshairHandler: ((param: MouseEventParams<Time>) => void) | null = null;

export function registerChart(id: ChartId, entry: ChartEntry): void {
  charts.set(id, entry);
  if (id === "main") {
    wireMain(entry.chart);
  } else if (wiredMainChart) {
    // align a newly-registered sub-panel to the main chart's current range
    // (the change-subscription only fires on subsequent changes)
    const r = wiredMainChart.timeScale().getVisibleLogicalRange();
    if (r) entry.chart.timeScale().setVisibleLogicalRange(r);
  }
}

export function unregisterChart(id: ChartId): void {
  if (id === "main") unwireMain();
  charts.delete(id);
}

function wireMain(mainChart: IChartApi): void {
  unwireMain();
  rangeHandler = (range) => {
    if (!range) return;
    for (const [id, c] of charts) {
      if (id === "main") continue;
      c.chart.timeScale().setVisibleLogicalRange(range);
    }
  };
  crosshairHandler = (param) => {
    for (const [id, c] of charts) {
      if (id === "main") continue;
      const v =
        param.time !== undefined && param.point && c.valueAt
          ? c.valueAt(param.time as unknown as number)
          : undefined;
      // only set when an aligned value exists, else clear — never snap the
      // horizontal line to a bogus price 0
      if (v === undefined || param.time === undefined) {
        c.chart.clearCrosshairPosition();
      } else {
        c.chart.setCrosshairPosition(v, param.time, c.series);
      }
    }
  };
  mainChart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
  mainChart.subscribeCrosshairMove(crosshairHandler);
  wiredMainChart = mainChart;
}

function unwireMain(): void {
  if (wiredMainChart) {
    try {
      if (rangeHandler) wiredMainChart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
      if (crosshairHandler) wiredMainChart.unsubscribeCrosshairMove(crosshairHandler);
    } catch {
      /* chart may already be removed */
    }
  }
  wiredMainChart = null;
  rangeHandler = null;
  crosshairHandler = null;
}
