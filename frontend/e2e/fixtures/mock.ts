// Hermetic backend mock for the e2e suite. Intercepts every REST `/api/**` call and
// the `/ws` WebSocket so the real Vikings frontend boots with deterministic candles —
// no Postgres / Redis / DataBento required. The `captured` fixture records the WS
// subscribe frames + REST footprint requests so tests can assert the cells-free
// candle-mode payload and scanner-click context switches.
import { test as base, expect, type Page } from "@playwright/test";

const TF_MIN: Record<string, number> = {
  "1m": 1, "2m": 2, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1D": 1440,
};

const SIGNALS = {
  absorption: false, absorptionPrice: null, absorptionSide: null,
  exhaustion: false, exhaustionType: null,
  lp: false, lpSide: null, lpPrice: null,
  ad: false, adValue: 0, deltaSpike: false, volumeSpike: false,
  hvn: [], lvn: [], volumeCluster: false,
  deltaDivergence: false, deltaDivergenceSide: null,
  stackedImbalances: [], activeZones: [],
};

// Deterministic candle series (no Date.now / Math.random so runs are reproducible).
// rowSize MUST match what the store expects for the symbol (GC.V.0 = 0.1) or the
// snapshot guard drops every candle.
export function genCandles(symbol: string, timeframe: string, rowSize: number, n: number, withCells: boolean) {
  const stepMs = (TF_MIN[timeframe] ?? 2) * 60_000;
  const startEpoch = 1_700_000_000_000;
  const base = 2000;
  const out: Record<string, unknown>[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const t = startEpoch + i * stepMs;
    const open = base + Math.sin(i / 7) * 5 + ((i % 5) - 2);
    const close = open + Math.cos(i / 5) * 2;
    const high = Math.max(open, close) + 1.5;
    const low = Math.min(open, close) - 1.5;
    const delta = Math.round(Math.sin(i / 3) * 50);
    cum += delta;
    const vol = 100 + (i % 10) * 5;
    const poc = Number(close.toFixed(1));
    const cells = withCells
      ? [{ price: poc, bidVolume: vol / 2, askVolume: vol / 2, delta, total: vol, buyImbalance: false, sellImbalance: false }]
      : [];
    out.push({
      symbol, timeframe, startTime: t, endTime: t + stepMs, rowSize,
      open, high, low, close, cells,
      totalVolume: vol, totalAskVolume: vol / 2, totalBidVolume: vol / 2,
      delta, cumDelta: cum,
      vwap: null, vwapSd1Upper: null, vwapSd1Lower: null, vwapSd2Upper: null, vwapSd2Lower: null,
      maxDelta: delta + 10, minDelta: delta - 10, poc, marketStructure: null,
      signals: { ...SIGNALS }, closed: true, tickCount: 10, replay: false,
    });
  }
  return out;
}

function scannerRows() {
  const mk = (tf: string) => ({
    symbol: "GC.V.0", timeframe: tf, price: 2000, delta: 12, cumDelta: 30,
    absorption: false, exhaustion: false, lp: false, ad: false, imbalances: 0,
    trend: "up", signals: [], updated: 1_700_000_000_000,
  });
  return [mk("2m"), mk("5m")];
}

export interface Captured {
  footprintReqs: URL[];
}

// the WS subscribe frames the page sent, recorded in-page by the WebSocket stub
export async function getSubscribes(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(() => (window as any).__mockSubs ?? []);
}

async function installRest(page: Page, captured: Captured) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (p.endsWith("/api/symbols")) return json({ symbols: ["GC.V.0", "6E.V.0"] });
    if (p.endsWith("/api/timeframes"))
      return json({ timeframes: ["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"], default: "2m" });
    if (p.endsWith("/api/scanner")) return json({ rows: scannerRows() });
    if (p.endsWith("/api/alerts")) return json({ alerts: [] });
    if (p.endsWith("/api/status"))
      return json({
        state: "connected", source: "databento", symbols: ["GC.V.0"], lastTickMs: 0,
        tickCount: 0, connectedSinceMs: 0, staleMs: null, message: "mock", pgEnabled: true,
      });
    if (p.endsWith("/api/symbol-config"))
      return json({ "GC.V.0": { row_size: 0.1, imbalance_ratio: 3, min_vol_for_highlight: 10 } });
    if (p.endsWith("/api/footprints")) {
      captured.footprintReqs.push(url);
      const symbol = url.searchParams.get("symbol") ?? "GC.V.0";
      const timeframe = url.searchParams.get("timeframe") ?? "2m";
      const rowSize = Number(url.searchParams.get("rowSize") ?? "0.1");
      const cells = url.searchParams.get("cells") !== "false"; // cells=false only in candle mode
      return json({ symbol, timeframe, candles: genCandles(symbol, timeframe, rowSize, cells ? 30 : 200, cells) });
    }
    if (p.endsWith("/api/trade/state")) return json({ positions: [], orders: [], fills: [] });
    return json({});
  });
}

// Replace window.WebSocket with an in-page stub. Passed as a PLAIN-JS STRING (not a
// transpiled function) so no TS syntax can survive into the page. Deterministic across
// contexts and reloads (unlike page.routeWebSocket, which delivered intermittently
// here): the snapshot frame is dispatched entirely inside the page via setTimeout(0),
// so the store reliably receives candles on boot and on every (re)subscribe.
const WS_STUB = `
(function () {
  var TF_MIN = {"1m":1,"2m":2,"3m":3,"5m":5,"15m":15,"30m":30,"1h":60,"4h":240,"1D":1440};
  var SIGNALS = {absorption:false,absorptionPrice:null,absorptionSide:null,exhaustion:false,exhaustionType:null,lp:false,lpSide:null,lpPrice:null,ad:false,adValue:0,deltaSpike:false,volumeSpike:false,hvn:[],lvn:[],volumeCluster:false,deltaDivergence:false,deltaDivergenceSide:null,stackedImbalances:[],activeZones:[]};
  function gen(symbol, timeframe, rowSize, n, withCells) {
    var stepMs = (TF_MIN[timeframe] || 2) * 60000, startEpoch = 1700000000000, base = 2000, out = [], cum = 0;
    for (var i = 0; i < n; i++) {
      var t = startEpoch + i * stepMs;
      var open = base + Math.sin(i / 7) * 5 + ((i % 5) - 2);
      var close = open + Math.cos(i / 5) * 2;
      var high = Math.max(open, close) + 1.5, low = Math.min(open, close) - 1.5;
      var delta = Math.round(Math.sin(i / 3) * 50); cum += delta;
      var vol = 100 + (i % 10) * 5, poc = Number(close.toFixed(1));
      var cells = withCells ? [{price:poc,bidVolume:vol/2,askVolume:vol/2,delta:delta,total:vol,buyImbalance:false,sellImbalance:false}] : [];
      out.push({symbol:symbol,timeframe:timeframe,startTime:t,endTime:t+stepMs,rowSize:rowSize,open:open,high:high,low:low,close:close,cells:cells,totalVolume:vol,totalAskVolume:vol/2,totalBidVolume:vol/2,delta:delta,cumDelta:cum,vwap:null,vwapSd1Upper:null,vwapSd1Lower:null,vwapSd2Upper:null,vwapSd2Lower:null,maxDelta:delta+10,minDelta:delta-10,poc:poc,marketStructure:null,signals:Object.assign({},SIGNALS),closed:true,tickCount:10,replay:false});
    }
    return out;
  }
  window.__mockSubs = [];
  function MockWS(url) {
    var self = this;
    self.url = url; self.readyState = 0;
    self.onopen = null; self.onmessage = null; self.onclose = null; self.onerror = null;
    self._snap = function (candles, symbol, timeframe) {
      if (self.onmessage) self.onmessage({ data: JSON.stringify({ type: "snapshot", data: { symbol: symbol, timeframe: timeframe, candles: candles } }) });
    };
    setTimeout(function () {
      self.readyState = 1;
      if (self.onopen) self.onopen({});
      self._snap(gen("GC.V.0", "2m", 0.1, 200, false), "GC.V.0", "2m");
    }, 0);
  }
  MockWS.CONNECTING = 0; MockWS.OPEN = 1; MockWS.CLOSING = 2; MockWS.CLOSED = 3;
  MockWS.prototype.send = function (data) {
    var m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m && m.action === "subscribe") {
      window.__mockSubs.push(m);
      var withCells = m.cells !== false;
      var c = gen(m.symbol, m.timeframe, Number(m.rowSize || 0.1), withCells ? 30 : 200, withCells);
      var self = this;
      setTimeout(function () { self._snap(c, m.symbol, m.timeframe); }, 0);
    }
  };
  MockWS.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose({}); };
  MockWS.prototype.addEventListener = function () {};
  MockWS.prototype.removeEventListener = function () {};
  window.WebSocket = MockWS;
})();
`;

async function installWs(page: Page) {
  await page.addInitScript(WS_STUB);
}

export const test = base.extend<{ captured: Captured }>({
  // `auto: true` so the backend mock installs for EVERY test, even ones that don't
  // destructure `captured` — otherwise the WS/REST stubs never register and the chart
  // never loads candles.
  captured: [
    async ({ page }, use) => {
      const captured: Captured = { footprintReqs: [] };
      await installWs(page); // addInitScript must run before any navigation
      await installRest(page, captured);
      await use(captured);
    },
    { auto: true },
  ],
});

export { expect };

// Wait until the boot snapshot has populated the chart (the "Loading …" overlay clears
// only once candles.length > 0).
export async function waitForCandles(page: Page) {
  await expect(page.getByText(/^Loading /)).toHaveCount(0, { timeout: 15_000 });
}

// Bounding box of the footprint chart host (the overlay div the drawing controller
// listens on; lightweight-charts' canvases live inside it). Using the host's testid
// avoids `canvas.first()` matching one of LWC's several stacked/offscreen canvases.
export async function chartCanvasBox(page: Page) {
  // reset any horizontal scroll a prior header-button click may have caused, so the
  // measured box is in the same frame the subsequent pointer gestures click in
  await page.evaluate(() => window.scrollTo(0, 0));
  const host = page.getByTestId("footprint-chart");
  await host.waitFor({ state: "visible" });
  const box = await host.boundingBox();
  if (!box) throw new Error("chart host has no bounding box");
  return box;
}
