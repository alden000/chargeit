import { describe, expect, it } from "vitest";
import { PROVIDER_APPS, detectPlatform, safeStoreUrl, storeLinks } from "../../src/provider-apps.ts";

describe("provider apps", () => {
  it("every bundled entry points only at official app stores", () => {
    for (const [slug, app] of Object.entries(PROVIDER_APPS)) {
      // Either a named app with at least one store link, or a payment note on its own.
      if (app.name) expect(app.ios || app.android, slug).toBeTruthy();
      else expect(app.note, slug).toBeTruthy();
      if (app.ios) expect(app.ios, slug).toMatch(/^https:\/\/apps\.apple\.com\/[a-z]{2}\/app\/[^/]+\/id\d+$/);
      if (app.android) expect(app.android, slug).toMatch(/^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+$/);
    }
  });
  it("rejects non-store URLs", () => {
    expect(safeStoreUrl("javascript:alert(1)")).toBeNull();
    expect(safeStoreUrl("https://evil.example/app")).toBeNull();
    expect(safeStoreUrl("http://apps.apple.com/sg/app/x/id1")).toBeNull();
    expect(safeStoreUrl("https://apps.apple.com/sg/app/x/id1")).toBe("https://apps.apple.com/sg/app/x/id1");
  });
  it("detects the platform and picks the matching store", () => {
    const app = { name: "X", ios: "https://apps.apple.com/sg/app/x/id1", android: "https://play.google.com/store/apps/details?id=x.y" };
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5)).toBe("ios"); // iPadOS
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 7)", 5)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0)", 0)).toBe("other");
    expect(storeLinks(app, "ios").map((l) => l.label)).toEqual(["App Store"]);
    expect(storeLinks(app, "android").map((l) => l.label)).toEqual(["Google Play"]);
    expect(storeLinks(app, "other").map((l) => l.label)).toEqual(["App Store", "Google Play"]);
    expect(storeLinks({ name: "Y", android: app.android }, "ios")).toEqual([]);
  });
});
