import { defineConfig } from "@playwright/test";

/**
 * Browser acceptance tests for the reception screen and the practitioner
 * calendar: the real console against the real API and PostgreSQL, with
 * synthetic data only. `npm run test:browser`.
 */
const database =
  process.env.BROWSER_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/access_browser_test";
const login = (role: string, password: string) => {
  const url = new URL(database);
  url.username = role;
  url.password = password;
  return url.toString();
};
const API_PORT = 3101;
const CONSOLE_PORT = 4173;

export default defineConfig({
  testDir: "tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  // One database: the scenarios run in order on distinct days.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "browser-report.json" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${CONSOLE_PORT}`,
    timezoneId: "Africa/Johannesburg",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: "npx tsx apps/core-api/src/server.ts",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        ACCESS_DATA_MODE: "SYNTHETIC",
        ACCESS_AUTH_MODE: "synthetic",
        API_DATABASE_URL: login("access_request", "integration-api"),
        ARTIFACT_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
        CONSOLE_ORIGIN: `http://localhost:${CONSOLE_PORT}`,
        ARTIFACT_STORE: "local",
        ARTIFACT_SCANNER: "mock",
        PORT: String(API_PORT),
      },
    },
    {
      command: `npm -w @access/console exec vite -- --port ${CONSOLE_PORT} --strictPort`,
      url: `http://localhost:${CONSOLE_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_CORE_API_URL: `http://localhost:${API_PORT}`,
        VITE_AUTH_MODE: "synthetic",
      },
    },
  ],
});
