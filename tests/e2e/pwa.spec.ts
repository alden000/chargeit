import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ready, test } from "./fixtures.ts";

test.describe("PWA & security", () => {
  test("web manifest is installable", async ({ page, api: _ }) => {
    await page.goto("/");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBeTruthy();
    const res = await page.request.get(href!);
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m.name).toContain("ChargeIt");
    expect(m.short_name).toBe("ChargeIt");
    expect(m.display).toBe("standalone");
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of m.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
  });

  test("service worker registers and the shell works offline", async ({ page, context, api }) => {
    await page.goto("/");
    await ready(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); // now controlled by the SW
    await ready(page);
    await context.setOffline(true);
    api.mode = "down"; // route mocks bypass offline mode, so take the API down too
    await page.reload();
    await expect(page.locator(".brand__word")).toBeVisible();
    await expect(page.locator(".card").first()).toBeVisible();
    await expect(page.locator("#live")).toContainText("Offline");
    await context.setOffline(false);
  });

  test("built bundle contains no LTA credentials or direct DataMall calls", () => {
    const dist = join(process.cwd(), "dist");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.(m?js|html|json|webmanifest|css)$/.test(e.name)) files.push(join(d, e.name));
      }
    };
    walk(dist);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/AccountKey/i);
      expect(text, f).not.toContain("datamall2.mytransport.sg");
      expect(text, f).not.toMatch(/LTA_ACCOUNT_KEY/);
    }
  });
});
