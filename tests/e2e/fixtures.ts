import { test as base, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ChargersPayload } from "../../shared/schema.ts";

export const snapshot = JSON.parse(readFileSync(new URL("../../public/demo/chargers.json", import.meta.url), "utf8")) as ChargersPayload;

/** A known station from the snapshot, for deterministic assertions. */
export const clarke = snapshot.stations.find((s) => s.name === "CLARKE QUAY")!;

export type ApiMode = "ok" | "down" | "stale";

export async function mockApi(page: Page, mode: () => ApiMode): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route("**/v1/chargers", async (route: Route) => {
    calls++;
    const m = mode();
    if (m === "down") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"upstream_unavailable"}' });
    const body = { ...snapshot, fetchedAt: new Date().toISOString(), feedUpdated: new Date(Date.now() - 120_000).toISOString() };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Stale, X-Feed-Updated", "X-Stale": m === "stale" ? "1" : "0" },
      body: JSON.stringify(body),
    });
  });
  // Keep runs hermetic: no basemap tiles (the app falls back to a plain style), canned place search.
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.route("https://www.onemap.gov.sg/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ results: [{ SEARCHVAL: "BISHAN MRT STATION", ADDRESS: "17 BISHAN PLACE", POSTAL: "NIL", LATITUDE: "1.3510", LONGITUDE: "103.8500" }] }),
    }),
  );
  return { calls: () => calls };
}

export const test = base.extend<{ api: { mode: ApiMode; calls: () => number } }>({
  api: async ({ page }, use) => {
    const state = { mode: "ok" as ApiMode, calls: () => 0 };
    const { calls } = await mockApi(page, () => state.mode);
    state.calls = calls;
    await use(state);
  },
});

export async function ready(page: Page): Promise<void> {
  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator(".card").first()).toBeVisible();
}

export { expect };
