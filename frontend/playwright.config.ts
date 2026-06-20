import { defineConfig, devices } from "@playwright/test";

// E2E runs against the PRODUCTION build served by `vite preview`, with the backend
// REST + WebSocket fully mocked (see e2e/fixtures/mock.ts) so the suite is hermetic —
// no Postgres / Redis / DataBento needed. One worker, serial: tests share a fixed
// preview port and assert localStorage, which is per-origin global.
const PORT = 4175;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 40_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // wide viewport so the header toolbar never overflows — otherwise clicking a
  // right-edge header button auto-scrolls the page horizontally and shifts the chart
  // off-screen, breaking canvas-coordinate gestures.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1680, height: 900 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
