import { clarke, expect, mockApi, ready, snapshot, test } from "./fixtures.ts";

test.describe("ChargeIt core journeys", () => {
  test("boots into live mode with pins, stats and a nearby list", async ({ page, api }) => {
    await page.goto("/");
    await expect(page.locator(".splash__word")).toHaveText("ChargeIt");
    await ready(page);
    await expect(page.locator("#live")).toHaveAttribute("data-state", "live");
    await expect(page.locator("#live")).toContainText("Live");
    await expect(page.locator(".pin-host").first()).toBeVisible();
    expect(await page.locator(".card").count()).toBeGreaterThan(3);
    await expect(page.locator(".s-free b")).not.toHaveText("0");
    expect(api.calls()).toBe(1);
  });

  test("Free now filter only lists stations with a free charger, and persists", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.getByRole("button", { name: "Free now" }).click();
    await expect(page.getByRole("button", { name: "Free now" })).toHaveAttribute("aria-pressed", "true");
    const avail = await page.locator(".card .avail").allTextContents();
    expect(avail.length).toBeGreaterThan(0);
    for (const t of avail) expect(t).toMatch(/^\d+\/\d+ free$/);
    await page.reload();
    await ready(page);
    await expect(page.getByRole("button", { name: "Free now" })).toHaveAttribute("aria-pressed", "true");
  });

  test("speed and provider menus filter the list", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.locator('[data-f="speed"]').click();
    await page.getByLabel(/≥ 100 kW/).click(); // single-choice: picking closes the menu
    await expect(page.locator('[data-f="speed"]')).toContainText("≥ 100 kW");
    const kws = await page.locator(".card .card__meta span:nth-child(2)").allTextContents();
    for (const t of kws) expect(parseFloat(t)).toBeGreaterThanOrEqual(100);

    await page.locator('[data-f="ops"]').click();
    await page.getByLabel(/^Shell Recharge/).check();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-f="ops"]')).toContainText("Shell Recharge");
    const ops = await page.locator(".card .op").allTextContents();
    for (const t of ops) expect(t).toContain("Shell Recharge");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator('[data-f="speed"]')).toContainText("Any speed");
  });

  test("tapping a card opens the detail with connectors, price and directions", async ({ page, api: _ }) => {
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
    await expect(page.locator("#view-detail .group").first()).toBeVisible();
    const cells = await page.locator("#view-detail .cell").count();
    const expected = clarke.points.reduce((n, p) => n + p.plugs.reduce((m, pl) => m + pl.connectors.length, 0), 0);
    expect(cells).toBe(expected);
    await expect(page.locator("#view-detail .group__price").first()).toContainText("$");
    await page.getByRole("button", { name: "Directions" }).click();
    const gmaps = page.getByRole("link", { name: "Google Maps" });
    await expect(gmaps).toHaveAttribute("href", new RegExp(`destination=${clarke.lat},${clarke.lng}`));
    await expect(page.getByRole("link", { name: "Waze" })).toBeVisible();

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#view-detail")).toBeHidden();
    await expect(page.locator("#view-list")).toBeVisible();
    expect(page.url()).not.toContain("#s=");
  });

  test("list → detail → back via the list card", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    const name = await page.locator(".card .card__name").first().innerText();
    await page.locator(".card").first().click();
    await expect(page.locator("#view-detail h2")).toHaveText(name.replace(/^★ /, ""));
    expect(page.url()).toContain("#s=");
    await page.keyboard.press("Escape");
    await expect(page.locator("#view-list")).toBeVisible();
  });

  test("search finds chargers by name and places via OneMap", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.locator("#search").fill("clarke quay");
    await expect(page.locator('.search__item[data-id]').first()).toContainText("Clarke Quay");
    await expect(page.locator(".search__item[data-place]").first()).toContainText("Bishan MRT Station");
    await page.locator('.search__item[data-id]').first().click();
    await expect(page.locator("#view-detail h2")).toContainText("Clarke Quay");

    await page.locator("#search").fill("bishan");
    await page.locator(".search__item[data-place]").first().click();
    await expect(page.locator("#toast")).toContainText("Chargers near Bishan MRT Station");
  });

  test("favourites persist and power the Saved filter", async ({ page, api: _ }) => {
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    const fav = page.locator('[data-act="fav"]');
    await expect(fav).toHaveAttribute("aria-pressed", "false");
    await fav.click();
    await expect(fav).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator('[data-f="favourites"]').click();
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card .card__name")).toContainText("Clarke Quay");
    await page.reload();
    await ready(page);
    await expect(page.locator(".card")).toHaveCount(1);
  });

  test("bottom sheet drags between snap points", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    const sheet = page.locator("#sheet");
    await expect(sheet).toHaveAttribute("data-snap", "peek");
    const grip = await page.locator(".sheet__grip").boundingBox();
    const vh = page.viewportSize()!.height;
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 5);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 5 - (vh * 0.75 * i) / 10);
    await page.mouse.up();
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await page.locator(".sheet__grip").click(); // tap the grip at full → back to peek
    await expect(sheet).toHaveAttribute("data-snap", "peek");
  });

  test("theme choice in Settings switches and persists", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const other = (await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)) ? "Dark" : "Light";
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: other }).click();
    await expect(page.getByRole("radio", { name: other })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(before);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(other.toLowerCase());
  });
});

test.describe("resilience", () => {
  test("API down on first visit → friendly error → demo snapshot", async ({ page, api }) => {
    api.mode = "down";
    await page.goto("/");
    await expect(page.getByText("We can't reach the live charger feed")).toBeVisible();
    await expect(page.locator("#live")).toHaveAttribute("data-state", "error");
    await page.getByRole("button", { name: "View demo snapshot" }).click();
    await expect(page.locator("#live")).toHaveAttribute("data-state", "demo");
    await expect(page.locator(".card").first()).toBeVisible();
  });

  test("API down after a good load → last good copy, marked offline", async ({ page, api }) => {
    await page.goto("/");
    await ready(page);
    api.mode = "down";
    await page.reload();
    await ready(page);
    await expect(page.locator("#live")).toHaveAttribute("data-state", "error");
    await expect(page.locator("#live")).toContainText("Offline");
  });

  test("stale upstream is labelled as delayed", async ({ page, api }) => {
    api.mode = "stale";
    await page.goto("/");
    await ready(page);
    await expect(page.locator("#live")).toHaveAttribute("data-state", "stale");
  });

  test("manual refresh refetches", async ({ page, api }) => {
    await page.goto("/");
    await ready(page);
    await page.locator("#live").click();
    await expect.poll(() => api.calls()).toBe(2);
  });

  test("?demo opens the bundled snapshot without calling the API", async ({ page, api }) => {
    await page.goto("/?demo");
    await ready(page);
    await expect(page.locator("#live")).toHaveAttribute("data-state", "demo");
    expect(api.calls()).toBe(0);
  });

  test("snapshot covers the island", () => {
    expect(snapshot.stations.length).toBeGreaterThan(1000);
  });
});

test.describe("geolocation", () => {
  test.use({ geolocation: { latitude: clarke.lat, longitude: clarke.lng }, permissions: ["geolocation"] });
  test("locate-me centres on the user and sorts by distance", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.locator("#locate").click();
    await expect(page.locator(".me")).toBeVisible();
    await expect(page.locator("#list-title")).toHaveText("Near you");
    await expect(page.locator(".card .card__name").first()).toContainText("Clarke Quay");
  });
});

test.describe("hardening (QA regressions)", () => {
  test("a malformed deep link is ignored and the app still reports Live", async ({ page, api: _ }) => {
    await page.goto("/#s=%E0%A4%A");
    await ready(page);
    await expect(page.locator("#live")).toHaveAttribute("data-state", "live");
  });

  test("a shared link opened in an already-open tab navigates to the station", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.evaluate((id) => (location.hash = `s=${encodeURIComponent(id)}`), clarke.id);
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  });

  test("poisoned saved filters can't inject markup", async ({ page, api: _ }) => {
    await page.addInitScript(() => {
      localStorage.setItem("chargeit:filters", JSON.stringify({ minKw: '<img src=x onerror="window.__pwned=1">', operators: [{ x: 1 }, "Shell Recharge"] }));
    });
    await page.goto("/");
    await expect(page.locator("#splash")).toHaveCount(0, { timeout: 8_000 });
    await expect(page.locator('[data-f="speed"]')).toContainText("Any speed");
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});

test.describe("corporate / fleet discounts", () => {
  const spPrice = () => {
    for (const p of clarke.points) for (const pl of p.plugs) if (pl.price) return pl.price;
    throw new Error("fixture: Clarke Quay has no price");
  };

  test("adding a provider discount re-prices the list and detail, and persists", async ({ page, api: _ }) => {
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
    const list = spPrice();

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.locator('.disc[data-name="SP Mobility"] .disc__row').click();
    await dialog.locator('.disc[data-name="SP Mobility"] [data-pct="20"]').click();
    await expect(dialog.locator('.disc[data-name="SP Mobility"] .disc__val')).toHaveText("−20%");
    // Active discounts float to the top.
    await expect(dialog.locator(".disc").first()).toHaveAttribute("data-name", "SP Mobility");
    await expect(page.locator("#settings-dot")).toBeVisible();

    // Custom value via the input.
    const input = dialog.locator('.disc[data-name="SP Mobility"] input');
    await input.fill("12.5");
    await input.press("Enter");
    await input.blur();
    await expect(dialog.locator('.disc[data-name="SP Mobility"] .disc__val')).toHaveText("−12.5%");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const expected = `$${(list * 0.875).toFixed(2)}`;
    await expect(page.locator("#view-detail .tile--deal b")).toHaveText(expected);
    await expect(page.locator("#view-detail .tile--deal s")).toHaveText(`$${list.toFixed(2)}`);
    await expect(page.locator("#view-detail .group__price.is-deal", { hasText: expected })).toHaveCount(1);

    await page.reload();
    await expect(page.locator("#view-detail .tile--deal b")).toHaveText(expected);
  });

  test("removing a discount restores list prices; junk input is rejected", async ({ page, api: _ }) => {
    await page.addInitScript(() => localStorage.setItem("chargeit:discounts", JSON.stringify({ "SP Mobility": 10, Evil: "<img src=x onerror=alert(1)>" })));
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await expect(page.locator("#view-detail .tile--deal")).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.locator('.disc[data-name="Evil"]')).toHaveCount(0);
    await dialog.locator('.disc[data-name="SP Mobility"] .disc__row').click();
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog.locator('.disc[data-name="SP Mobility"] .disc__val')).toHaveText("Add");
    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#view-detail .tile--deal")).toHaveCount(0);
    await expect(page.locator("#settings-dot")).toBeHidden();
  });
});

test("station detail names the provider's app and links the right store", async ({ page, api: _ }, info) => {
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  const row = page.locator("#view-detail .provider.has-app", { hasText: "SP Mobility" });
  await expect(row).toContainText("Charge with SP: Utilities & EV Charging");
  const link = row.getByRole("link", { name: /Get SP: Utilities & EV Charging on/ });
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  if (info.project.name === "android") expect(href).toBe("https://play.google.com/store/apps/details?id=sg.com.singaporepower.spservices");
  else expect(href).toBe("https://apps.apple.com/sg/app/sp-utilities-ev-charging/id596749130");
  await expect(link).toHaveAttribute("rel", "noopener");
});

test("map pins show the provider; filtering a provider puts its logo on the pins", async ({ page, api: _ }) => {
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Zoomed in on a station: individual pins carry a provider badge and name it for screen readers.
  await expect(page.locator(".pin-host .pin__op").first()).toBeVisible();
  await expect(page.locator('.pin-host[aria-label^="Clarke Quay, SP Mobility"]')).toHaveCount(1);
  await expect(page.locator('.pin-host[aria-label^="Clarke Quay, "] .pin__op img')).toHaveAttribute("src", /providers\/sp\.png$/);

  await page.locator('[data-f="ops"]').click();
  await page.getByLabel(/^Shell Recharge/).check();
  await page.keyboard.press("Escape");
  await expect.poll(async () => {
    const srcs = await page.locator(".pin-host .pin__op img").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
    return srcs.length > 0 && srcs.every((s) => s?.endsWith("providers/shell.png"));
  }).toBe(true);
});

test("discounted providers are highlighted on the map, others fade; the switch turns it off", async ({ page, api: _ }) => {
  await page.addInitScript(() => localStorage.setItem("chargeit:discounts", JSON.stringify({ "SP Mobility": 15 })));
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Clarke Quay is SP: highlighted with SP's badge.
  const clarkePin = page.locator('.pin-host[aria-label^="Clarke Quay, "] .pin');
  await expect(clarkePin).toHaveClass(/is-mine/);
  await expect(clarkePin.locator(".pin__op img")).toHaveAttribute("src", /providers\/sp\.png$/);
  await expect(page.locator(".pin.is-dim").first()).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: /Highlight my providers/ }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator(".pin.is-mine, .pin.is-dim")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".pin-host .pin").first()).toBeVisible();
  await expect(page.locator(".pin.is-mine, .pin.is-dim")).toHaveCount(0);
});

test("no discounts means no highlighting", async ({ page, api: _ }) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator(".pin-host .pin").first()).toBeVisible();
  await expect(page.locator(".pin.is-mine, .pin.is-dim")).toHaveCount(0);
});

test("price slider: hides dearer and unlisted sites; Any restores everything", async ({ page, api: _ }) => {
  await page.goto("/");
  await ready(page);
  const total = await page.evaluate(() => (window as unknown as { __chargeit: { state: { filtered: unknown[] } } }).__chargeit.state.filtered.length);
  await page.locator('[data-f="price"]').click();
  const slider = page.getByRole("slider", { name: "Maximum price per kWh" });
  await expect(slider).toBeVisible();
  await slider.fill("0.6");
  await expect(page.locator(".price-menu [data-out]")).toHaveText("Up to $0.60/kWh");
  await expect(page.locator('[data-f="price"]')).toContainText("≤ $0.60");
  const filtered = await page.evaluate(() => (window as unknown as { __chargeit: { state: { filtered: Array<{ points: Array<{ plugs: Array<{ price: number | null; priceType: string }> }> }> } } }).__chargeit.state.filtered);
  expect(filtered.length).toBeGreaterThan(0);
  expect(filtered.length).toBeLessThan(total);
  for (const s of filtered) {
    const prices = s.points.flatMap((p) => p.plugs.map((pl) => (pl.priceType === "free" ? 0 : pl.price))).filter((x): x is number => x !== null);
    expect(prices.length).toBeGreaterThan(0); // unlisted are gone
    expect(Math.min(...prices)).toBeLessThanOrEqual(0.6 + 1e-9);
  }
  await page.getByRole("button", { name: "Done" }).click();
  for (const t of await page.locator(".card .card__meta").allInnerTexts()) expect(t).toMatch(/from \$0\.[0-5]\d|from \$0\.60|Free/);

  // Persisted across reloads.
  await page.reload();
  await ready(page);
  await expect(page.locator('[data-f="price"]')).toContainText("≤ $0.60");
  await page.locator('[data-f="price"]').click();
  await page.getByRole("button", { name: "Any price" }).click();
  await expect(page.locator('[data-f="price"]')).toContainText("Any price");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __chargeit: { state: { filtered: unknown[] } } }).__chargeit.state.filtered.length)).toBe(total);
});

test("sort chip: Cheapest orders the list by effective price, unlisted last; remembered", async ({ page, api: _ }) => {
  await page.addInitScript(() => localStorage.setItem("chargeit:discounts", JSON.stringify({ "SP Mobility": 20 })));
  await page.goto("/");
  await ready(page);
  const sort = page.locator('[data-f="sort"]');
  await expect(sort).toContainText("Nearest");
  await sort.click();
  await expect(sort).toContainText("Cheapest");
  await expect(sort).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#list-title")).toContainText("Cheapest");
  const parse = (t: string) => (t === "Free" ? 0 : t === "No price" ? Infinity : parseFloat(t.replace(/[^0-9.]/g, "")));
  const prices = (await page.locator(".card .card__price").allInnerTexts()).map(parse);
  expect(prices.length).toBeGreaterThan(3);
  for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
  // Prices shown are after the user's discount: an SP site shows its discounted price.
  const spCard = page.locator(".card", { has: page.locator(".op", { hasText: "SP Mobility" }) }).first();
  if (await spCard.count()) await expect(spCard.locator(".card__price")).toBeVisible();

  await page.reload();
  await ready(page);
  await expect(page.locator('[data-f="sort"]')).toContainText("Cheapest");
  await page.locator('[data-f="sort"]').click();
  await expect(page.locator('[data-f="sort"]')).toContainText("Nearest");
  await expect(page.locator(".card .card__price")).toHaveCount(0);
});

test("picking a searched place centres the map even if the keyboard closing resizes the page", async ({ page, api: _ }) => {
  await page.goto("/");
  await ready(page);
  await page.evaluate(() => (window as unknown as { __chargeit: { cmap: { map: { jumpTo(o: object): void } } } }).__chargeit.cmap.map.jumpTo({ center: [103.79, 1.437], zoom: 15 }));
  await page.locator("#search").fill("bishan");
  await page.locator(".search__item[data-place]").first().click();
  // Simulate the on-screen keyboard closing mid-flight (viewport grows back).
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
  await page.waitForTimeout(120);
  await page.setViewportSize(vp);
  await expect
    .poll(
      async () => {
        const c = await page.evaluate(() => (window as unknown as { __chargeit: { cmap: { map: { getCenter(): { lat: number; lng: number } } } } }).__chargeit.cmap.map.getCenter());
        return Math.abs(c.lat - 1.351) < 0.002 && Math.abs(c.lng - 103.85) < 0.002;
      },
      { timeout: 8000 },
    )
    .toBe(true);
});

test("map stays flat and north-up: no tilt, no rotation", async ({ page, api: _ }) => {
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  await page.waitForTimeout(2500); // let the fly-in finish
  const cam = () =>
    page.evaluate(() => {
      const m = (window as unknown as { __chargeit: { cmap: { map: { getPitch(): number; getBearing(): number; dragRotate: { isEnabled(): boolean } } } } }).__chargeit.cmap.map;
      return { pitch: m.getPitch(), bearing: m.getBearing(), rotate: m.dragRotate.isEnabled() };
    });
  expect(await cam()).toEqual({ pitch: 0, bearing: 0, rotate: false });
  // A right-drag (desktop rotate/tilt gesture) must not change anything.
  await page.mouse.move(200, 300);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(280, 220, { steps: 6 });
  await page.mouse.up({ button: "right" });
  expect(await cam()).toEqual({ pitch: 0, bearing: 0, rotate: false });
});

test.describe("recent searches", () => {
  const pickCharger = async (page: import("@playwright/test").Page, q: string) => {
    await page.locator("#search").fill(q);
    await page.locator(".search__item[data-id]").first().click();
    await expect(page.locator("#view-detail")).toBeVisible();
  };

  test("remembers picks, shows them on focus, deletes one, clears all", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await pickCharger(page, "clarke quay");
    await page.locator("#search").fill("bishan");
    await page.locator(".search__item[data-place]").first().click();
    await expect(page.locator("#search")).toHaveValue(""); // cleared after a pick

    await page.locator("#search").click();
    const items = page.locator(".search__item--recent");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Bishan MRT Station"); // most recent first
    await expect(items.nth(1)).toContainText("Clarke Quay");
    await expect(items.nth(1)).toContainText(/free|in use|Out of service/); // live availability

    await page.getByRole("button", { name: "Remove Bishan MRT Station from recent searches" }).click();
    await expect(items).toHaveCount(1);
    await expect(page.locator("#search")).toBeFocused();

    // Persisted; picking a recent re-opens it.
    await page.reload();
    await ready(page);
    await page.locator("#search").click();
    await expect(items).toHaveCount(1);
    await items.first().click();
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");

    await page.locator("#search").click();
    await page.getByRole("button", { name: "Clear" }).first().click();
    await expect(page.locator("#search-results")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("chargeit:recents"))).toBe("[]");
  });

  test("keeps only the last 5 and ignores tampered storage", async ({ page, api: _ }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "chargeit:recents",
        JSON.stringify([{ kind: "place", label: "<img src=x onerror=window.__x=1>", sub: "", lat: "nope", lng: 1 }, { kind: "evil" }, 42]),
      ),
    );
    await page.goto("/");
    await ready(page);
    await page.locator("#search").click();
    await expect(page.locator(".search__item--recent")).toHaveCount(0);
    for (const q of ["clarke quay", "plaza singapura", "the cathay", "bishan", "orchard", "marina"]) {
      await page.locator("#search").fill(q);
      const first = page.locator(".search__item[data-id]").first();
      if (!(await first.count())) continue;
      await first.click();
      await expect(page.locator("#view-detail")).toBeVisible();
    }
    await page.locator("#search").click();
    expect(await page.locator(".search__item--recent").count()).toBeLessThanOrEqual(5);
    expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
  });
});

test("live pill counts down to LTA's next snapshot and refreshes on time", async ({ page }) => {
  await page.clock.install();
  await mockApi(page, () => "ok");
  // Feed stamped 2 min ago; every later request gets the next 5-minute snapshot.
  const stamp = Date.now() - 120_000;
  let calls = 0;
  await page.route("**/v1/chargers", (route) => {
    const feedUpdated = new Date(stamp + (calls++ ? 300_000 : 0)).toISOString();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...snapshot, fetchedAt: new Date().toISOString(), feedUpdated }) });
  });
  await page.goto("/");
  const count = page.locator("#live .live__next .live__count");
  await expect(count).toBeVisible();
  await expect(count).toHaveText(/^3:[0-4]\d$/); // due ~3:40 from now
  const before = calls;
  await page.clock.runFor(60_000);
  await expect(count).toHaveText(/^2:[0-4]\d$/);
  expect(calls).toBe(before); // no blind polling in between
  await page.clock.runFor(170_000);
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(count).toHaveText(/^4:\d\d$/); // rescheduled from the new snapshot
});
