import { test, expect, waitForCandles } from "./fixtures/mock";

const openSettings = async (page: import("@playwright/test").Page) => {
  await page.locator('[title="Footprint settings"]').click();
};

test.describe("footprint settings", () => {
  test("clean defaults: VWAP / SD bands / badges OFF, fills + thin candle ON", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openSettings(page);

    await expect(page.getByRole("checkbox", { name: "VWAP line" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "SD bands (SD1 & SD2)" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Signal badges (LP / AD / A / E)" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Execution fills" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Thin candle beside footprints" })).toBeChecked();
  });

  test("a toggled setting persists across reload", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openSettings(page);

    const vwap = page.getByRole("checkbox", { name: "VWAP line" });
    await vwap.check();
    await expect(vwap).toBeChecked();

    // persisted immediately to localStorage under the manual-persistence key
    const persisted = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("vikings.settings.v1") || "{}"),
    );
    expect(persisted.showVwap).toBe(true);

    await page.reload();
    await waitForCandles(page);
    await openSettings(page);
    await expect(page.getByRole("checkbox", { name: "VWAP line" })).toBeChecked();
  });

  test("reset to defaults clears a user toggle", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openSettings(page);

    await page.getByRole("checkbox", { name: "VWAP line" }).check();
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(page.getByRole("checkbox", { name: "VWAP line" })).not.toBeChecked();
  });
});
