import { test, expect, waitForCandles } from "./fixtures/mock";
import type { Page } from "@playwright/test";

const indList = (page: Page) =>
  page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem("vikings.indicators.v1") || "{}").indicators || []).map(
        (i: { name: string; enabled: boolean; inputs?: Record<string, unknown> }) => ({ name: i.name, enabled: i.enabled, inputs: i.inputs }),
      );
    } catch {
      return [];
    }
  });

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="indicator-legend-row"][data-indicator-name="${name}"]`);

async function openFxAndAdd(page: Page, name: string) {
  await page.locator('[title="Custom indicators"]').click();
  await expect(page.getByText("ƒx Indicators")).toBeVisible();
  await page.getByRole("button", { name: `+ ${name}`, exact: true }).click();
}

test.describe("TradingView-style indicator controls", () => {
  test("adding from fx closes the panel and shows a legend row", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openFxAndAdd(page, "CVD MA");
    // fx dialog auto-closes on add
    await expect(page.getByText("ƒx Indicators")).toHaveCount(0);
    // legend row appears in the chart pane
    await expect(row(page, "CVD MA")).toBeVisible();
    await expect.poll(async () => (await indList(page)).filter((i) => i.name === "CVD MA").length).toBe(1);
  });

  test("clicking outside the fx panel closes it", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await page.locator('[title="Custom indicators"]').click();
    await expect(page.getByText("ƒx Indicators")).toBeVisible();
    await page.mouse.click(5, 400); // far outside the centered panel
    await expect(page.getByText("ƒx Indicators")).toHaveCount(0);
  });

  test("eye toggles enabled; legend row stays", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openFxAndAdd(page, "CVD MA");
    const r = row(page, "CVD MA");
    await expect(r).toBeVisible();
    await r.getByTitle("Hide").click(); // was enabled -> hide
    await expect.poll(async () => (await indList(page)).find((i) => i.name === "CVD MA")?.enabled).toBe(false);
    await expect(r).toBeVisible(); // row remains, dimmed
    await r.getByTitle("Show").click();
    await expect.poll(async () => (await indList(page)).find((i) => i.name === "CVD MA")?.enabled).toBe(true);
  });

  test("settings: Cancel discards, OK persists", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openFxAndAdd(page, "CVD MA"); // single instance (no default-name collision)
    const r = row(page, "CVD MA");
    await r.getByTitle("Settings").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("CVD MA")).toBeVisible();
    const num = dialog.locator('input[type="number"]').first();
    const orig = await num.inputValue(); // length = 20
    await num.fill(String(Number(orig) + 111));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // re-open: value unchanged
    await r.getByTitle("Settings").click();
    await expect(page.getByRole("dialog").locator('input[type="number"]').first()).toHaveValue(orig);
    // now change + OK
    await page.getByRole("dialog").locator('input[type="number"]').first().fill(String(Number(orig) + 222));
    await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
    await expect.poll(async () => {
      const cvd = (await indList(page)).find((i) => i.name === "CVD MA");
      return cvd?.inputs?.length;
    }).toBe(Number(orig) + 222);
  });

  test("source dialog opens; Cancel does not mutate", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openFxAndAdd(page, "CVD MA");
    const r = row(page, "CVD MA");
    await r.getByTitle("Source code").click();
    await expect(page.getByText(/^Source code — CVD MA/)).toBeVisible();
    await expect(page.getByRole("dialog").locator("textarea")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(/^Source code —/)).toHaveCount(0);
  });

  test("three-dot menu opens and closes on outside click; delete removes the row", async ({ page }) => {
    await page.goto("/");
    await waitForCandles(page);
    await openFxAndAdd(page, "CVD MA");
    const r = row(page, "CVD MA");
    await r.getByTitle("More").click();
    await expect(page.getByText("Settings…")).toBeVisible();
    await page.mouse.click(5, 400); // outside
    await expect(page.getByText("Settings…")).toHaveCount(0);
    // delete via the row trash
    await r.getByTitle("Remove").click();
    await expect(row(page, "CVD MA")).toHaveCount(0);
  });
});
