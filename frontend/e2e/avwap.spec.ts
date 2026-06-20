import { test, expect, waitForCandles, chartCanvasBox } from "./fixtures/mock";
import type { Page } from "@playwright/test";

const avwapCount = (page: Page) =>
  page.evaluate(() => {
    try {
      const inds = JSON.parse(localStorage.getItem("vikings.indicators.v1") || "{}").indicators || [];
      return inds.filter((i: { kind?: string }) => i.kind === "anchored-vwap").length;
    } catch {
      return -1;
    }
  });

async function placeAvwap(page: Page) {
  await page.getByTitle(/^Anchored VWAP/).click();
  await expect(page.getByText("Click a candle to anchor Anchored VWAP")).toBeVisible();
  const box = await chartCanvasBox(page);
  // click a visible bar mid-chart — avoid the right-offset whitespace where no candle
  // resolves (the chart opens zoomed to the latest bars, with rightOffset blank space)
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
}

test.describe("Anchored VWAP on chart", () => {
  test("place a new AVWAP by clicking a candle", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    await expect.poll(() => avwapCount(page)).toBe(0);
    await placeAvwap(page);
    await expect.poll(() => avwapCount(page)).toBe(1);
  });

  test("select an AVWAP from the Object Tree, then delete it", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await placeAvwap(page);
    await expect.poll(() => avwapCount(page)).toBe(1);

    // selecting it from the Object Tree shows the on-chart AVWAP selection toolbar
    await page.getByRole("button", { name: "Open object tree" }).click();
    await page.getByText(/^Anchored VWAP/).first().click();
    await expect(page.getByRole("button", { name: "Re-anchor" })).toBeVisible();

    // deleting from that toolbar removes the AVWAP everywhere (store is the single source)
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => avwapCount(page)).toBe(0);
    await expect(page.getByRole("button", { name: "Re-anchor" })).toHaveCount(0);
  });

  test("Delete key removes a selected AVWAP", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await placeAvwap(page);
    await expect.poll(() => avwapCount(page)).toBe(1);

    await page.getByRole("button", { name: "Open object tree" }).click();
    await page.getByText(/^Anchored VWAP/).first().click();
    await expect(page.getByRole("button", { name: "Re-anchor" })).toBeVisible();

    await page.keyboard.press("Delete");
    await expect.poll(() => avwapCount(page)).toBe(0);
  });
});
