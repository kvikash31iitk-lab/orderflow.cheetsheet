import { test, expect, waitForCandles } from "./fixtures/mock";

test.describe("scanner row click", () => {
  test("clicking a different-timeframe row switches context without blanking the chart", async ({ page, captured }) => {
    await page.goto("/");
    await waitForCandles(page);

    // scanner seeds GC.V.0 rows for 2m (active) + 5m; click the 5m row
    const row5m = page.locator("tr", { hasText: "(5m)" });
    await expect(row5m).toBeVisible();
    await row5m.click();

    // the context switch pulls a fresh REST snapshot for 5m...
    await expect
      .poll(() => captured.footprintReqs.some((u) => u.searchParams.get("timeframe") === "5m"))
      .toBe(true);

    // ...and the chart never ends up blank (the "Loading" overlay clears again)
    await waitForCandles(page);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("clicking the already-active row is a no-op (no blank flash assertion)", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    await page.locator("tr", { hasText: "(2m)" }).click();
    // still populated
    await waitForCandles(page);
    await expect(page.locator("canvas").first()).toBeVisible();
  });
});
