import { test, expect, waitForCandles, getSubscribes } from "./fixtures/mock";

test.describe("boot + cells-free payload", () => {
  test("boots without uncaught errors and loads candles", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");
    await expect(page.locator("canvas").first()).toBeVisible();
    await waitForCandles(page);

    expect(errors, `uncaught page errors:\n${errors.join("\n")}`).toEqual([]);
    expect((await getSubscribes(page)).length).toBeGreaterThan(0);
  });

  test("default candle mode requests a cells-free snapshot", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    // chartDisplayMode defaults to "candle" -> the WS subscribe must ask for cells:false
    const subs = await getSubscribes(page);
    const sub = subs[0];
    expect(sub.symbol).toBe("GC.V.0");
    expect(sub.cells).toBe(false);
    expect(sub.limit).toBeGreaterThanOrEqual(15000);
  });
});
