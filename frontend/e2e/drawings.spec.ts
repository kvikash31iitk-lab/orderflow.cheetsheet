import { test, expect, waitForCandles, chartCanvasBox } from "./fixtures/mock";
import type { Page } from "@playwright/test";

const drawingCount = (page: Page) =>
  page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem("vikings.drawings.v1") || "{}").drawings || []).length;
    } catch {
      return -1;
    }
  });

async function drawRectangle(page: Page) {
  await page.getByRole("button", { name: "Rectangle" }).click();
  const box = await chartCanvasBox(page);
  const x1 = box.x + box.width * 0.4;
  const y1 = box.y + box.height * 0.4;
  const x2 = box.x + box.width * 0.62;
  const y2 = box.y + box.height * 0.62;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x1 + 8, y1 + 8);
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
}

test.describe("drawings", () => {
  test("create a rectangle -> persisted + listed in the Object Tree", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    await drawRectangle(page);
    await expect.poll(() => drawingCount(page)).toBe(1);

    await page.getByRole("button", { name: "Open object tree" }).click();
    // scope to the Object Tree window (the selection toolbar also shows the name)
    await expect(page.getByLabel("◳ Objects").getByText("Rectangle 1")).toBeVisible();
  });

  test("undo removes the last drawing, redo restores it", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    await drawRectangle(page);
    await expect.poll(() => drawingCount(page)).toBe(1);

    await page.keyboard.press("Control+z");
    await expect.poll(() => drawingCount(page)).toBe(0);

    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => drawingCount(page)).toBe(1);

    // toolbar Undo button is the same path
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => drawingCount(page)).toBe(0);
  });

  test("magnet button cycles snap modes off -> OHLC -> POC -> VWAP", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);

    const magnet = () => page.locator('[aria-label^="Magnet snap mode"]');
    await expect(magnet()).toHaveAttribute("aria-label", "Magnet snap mode: Off");
    await magnet().click();
    await expect(magnet()).toHaveAttribute("aria-label", "Magnet snap mode: OHLC");
    await magnet().click();
    await expect(magnet()).toHaveAttribute("aria-label", "Magnet snap mode: POC");
    await magnet().click();
    await expect(magnet()).toHaveAttribute("aria-label", "Magnet snap mode: VWAP");
    await magnet().click();
    await expect(magnet()).toHaveAttribute("aria-label", "Magnet snap mode: Off");
  });
});
