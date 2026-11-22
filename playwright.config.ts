import { defineConfig } from "@playwright/test";

/**
 * End-to-end UI tests: the built UI served by the real Node core (standalone
 * mode, temporary home, scripted fake provider), driven in headless Chromium.
 * Run `pnpm build` first (`pnpm test:ui` does both).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Windows CI can exhaust Chromium's network buffers; on macOS, a second browser
  // competes with the sidebar's frame-timing check. Keep those CI runs isolated.
  workers: process.env.CI && (process.platform === "win32" || process.platform === "darwin") ? 1 : 2,
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
