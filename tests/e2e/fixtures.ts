import { test as base, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ChargersPayload } from "../../shared/schema.ts";
import { statusString, stripStatusJson } from "../../shared/split.ts";

export const snapshot = JSON.parse(readFileSync(new URL("../../public/demo/chargers.json", import.meta.url), "utf8")) as ChargersPayload;

/** A known station from the snapshot, for deterministic assertions. */
export const clarke = snapshot.stations.find((s) => s.name === "CLARKE QUAY")!;

export type ApiMode = "ok" | "down" | "stale";

export const TEST_SV = "test-sv";
const stationsBody = `{"v":1,"sv":"${TEST_SV}","cv":"test-cv","stations":${stripStatusJson(JSON.stringify(snapshot.stations))}}`;

/** /v1/status as the Worker serves it; `feedUpdated` defaults to 2 minutes ago. */
export function statusBody(feedUpdated = new Date(Date.now() - 120_000).toISOString()): string {
  return JSON.stringify({ v: 1, feedUpdated, fetchedAt: new Date().toISOString(), sv: TEST_SV, cv: "test-cv", s: statusString(snapshot.stations) });
}

export async function mockApi(page: Page, mode: () => ApiMode): Promise<{ calls: () => number; stationCalls: () => number }> {
  let calls = 0;
  let stationCalls = 0;
  const headers = (m: ApiMode) => ({ "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Stale, X-Feed-Updated", "X-Stale": m === "stale" ? "1" : "0" });
  const down = (route: Route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"upstream_unavailable"}' });
  await page.route("**/v1/status", async (route: Route) => {
    calls++;
    const m = mode();
    if (m === "down") return down(route);
    return route.fulfill({ status: 200, contentType: "application/json", headers: headers(m), body: statusBody() });
  });
  await page.route("**/v1/stations?*", async (route: Route) => {
    stationCalls++;
    const m = mode();
    if (m === "down") return down(route);
    return route.fulfill({ status: 200, contentType: "application/json", headers: headers(m), body: stationsBody });
  });
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
  return { calls: () => calls, stationCalls: () => stationCalls };
}

export const test = base.extend<{ api: { mode: ApiMode; calls: () => number; stationCalls: () => number } }>({
  api: async ({ page }, use) => {
    const state = { mode: "ok" as ApiMode, calls: () => 0, stationCalls: () => 0 };
    const { calls, stationCalls } = await mockApi(page, () => state.mode);
    state.calls = calls;
    state.stationCalls = stationCalls;
    await use(state);
  },
});

export async function ready(page: Page): Promise<void> {
  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator(".card").first()).toBeVisible();
}

export { expect };
