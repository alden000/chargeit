import { defineConfig, devices } from "@playwright/test";

// Local sandboxes may provide a preinstalled Chromium; CI uses Playwright's own.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const launchOptions = { executablePath, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] };

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "android", use: { ...devices["Pixel 7"], launchOptions } },
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium", launchOptions } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions }, testMatch: /layout\.spec/ },
  ],
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
