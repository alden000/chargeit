import { clarke, expect, mockApi, ready, snapshot, statusBody, test } from "./fixtures.ts";

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
  // The station's best (lowest) list price, which is what the detail tile shows.
  const spPrice = () => {
    const prices = clarke.points.flatMap((p) => p.plugs.map((pl) => pl.price)).filter((x): x is number => !!x);
    if (!prices.length) throw new Error("fixture: Clarke Quay has no price");
    return Math.min(...prices);
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
  await page.route("**/v1/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: statusBody(new Date(stamp + (calls++ ? 300_000 : 0)).toISOString()) }),
  );
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

test("refreshes download only availability; the stations file is fetched once and kept on the device", async ({ page, api }) => {
  await page.goto("/");
  await ready(page);
  expect(api.stationCalls()).toBe(1);
  await page.getByRole("button", { name: /Live/ }).click(); // manual refresh
  await expect.poll(() => api.calls()).toBeGreaterThanOrEqual(2);
  expect(api.stationCalls()).toBe(1);
  await page.reload();
  await ready(page);
  expect(api.stationCalls()).toBe(1); // came from the device, not the network
});

test("falls back to the full endpoint when the split endpoints are missing (older proxy)", async ({ page, api: _ }) => {
  await page.route("**/v1/status", (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }));
  let full = 0;
  page.on("request", (r) => r.url().endsWith("/v1/chargers") && full++);
  await page.goto("/");
  await ready(page);
  expect(full).toBeGreaterThan(0);
  await expect(page.locator("#live")).toHaveAttribute("data-state", "live");
});

test("old-style station ids in favourites, recents and links still work", async ({ page, api: _ }) => {
  expect(clarke.id).toBe("179024");
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("chargeit:favs", JSON.stringify(["179024-8wmn7h"]));
    localStorage.setItem("chargeit:recents", JSON.stringify([{ kind: "station", id: "179024-8wmn7h", label: "Clarke Quay", sub: "" }]));
  });
  await page.goto("/#s=179024-8wmn7h");
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  await expect.poll(() => page.evaluate(() => [localStorage.getItem("chargeit:favs"), JSON.parse(localStorage.getItem("chargeit:recents") ?? "[]")[0]?.id])).toEqual(['["179024"]', "179024"]);
});

test("charger history: durations on tiles, a tapped charger's sessions, and busy hours by weekday", async ({ page, api: _ }) => {
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  const tile = page.locator("#view-detail button.cell").first();
  await expect(tile.locator(".cell__dur")).toHaveText(/^\d+m$|^\d+h( \d+m)?$/);
  await expect(tile.locator(".cell__since")).toHaveText(/^since \d\d:\d\d$/);
  // A charger that was already in its state when tracking began shows a minimum.
  const atLeast = page.locator("#view-detail button.cell").nth(2);
  if (await atLeast.count()) {
    await expect(atLeast.locator(".cell__dur")).toHaveText(/\+$/);
    await expect(atLeast.locator(".cell__since")).toHaveText("");
    await expect(page.locator(".cells-note")).toContainText("at least that long");
  }
  await expect(page.locator(".bh__sum")).toHaveText("Busiest 6pm–9pm");
  await expect(page.locator(".bh__bar")).toHaveCount(24);
  await expect(page.locator('.bh__day[aria-pressed="true"]')).toHaveClass(/is-today/);

  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".story")).toContainText(/(In use|Free) since (\w{3} )?\d\d:\d\d \(\d+ min\)\. Previous session (\w{3} )?\d\d:\d\d–(\w{3} )?\d\d:\d\d \(1 h 30 min\)\./);
  await expect(page.locator(".bh__who")).toContainText("Show all");

  await page.locator('.bh__day[data-day="0"]').click();
  await expect(page.locator('.bh__day[data-day="0"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.locator(".story")).toHaveCount(0);
});

test("charger history unavailable: the station screen works as before", async ({ page, api }) => {
  await page.route("**/v1/history?*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
  await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
  await expect(page.locator("#view-detail .cell").first()).toBeVisible();
  await expect(page.locator(".bh")).toHaveCount(0);
  expect(api.calls()).toBeGreaterThan(0);
});

test.describe("charger alerts", () => {
  async function mockAlerts(page: import("@playwright/test").Page) {
    const posts: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    let n = 0;
    await page.addInitScript(() => {
      const fake = {
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "BTest", auth: "aTest" } }),
      };
      // Simulate push support whether or not this browser build has it (CI's headless shell doesn't).
      const w = window as unknown as Record<string, unknown>;
      if (!("PushManager" in window)) w.PushManager = class {};
      if (!("Notification" in window)) w.Notification = class {};
      // The headless shell reports "denied" even when the test grants permission.
      Object.defineProperty(Notification, "permission", { get: () => "granted", configurable: true });
      Object.defineProperty(Notification, "requestPermission", { value: async () => "granted", configurable: true });
      const pm = { getSubscription: async () => null, subscribe: async () => fake };
      Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { get: () => pm, configurable: true });
    });
    await page.route("**/v1/push/key", (r) => r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ key: "B" + "A".repeat(86) }) }));
    await page.route("**/v1/watch*", async (r) => {
      const req = r.request();
      const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Owner-Key", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
      if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: h });
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() ?? "{}");
        posts.push(body);
        const expires = body.minutes === 0 ? 6_000_000_000_000 : Date.now() + 2 * 3600_000;
        return r.fulfill({ status: 201, contentType: "application/json", headers: h, body: JSON.stringify({ id: `watch-id-000000000${++n}`, expires }) });
      }
      if (req.method() === "DELETE") {
        deletes.push(new URL(req.url()).searchParams.get("id") ?? "");
        return r.fulfill({ contentType: "application/json", headers: h, body: '{"ok":true}' });
      }
      const ids = (new URL(req.url()).searchParams.get("ids") ?? "").split(",").filter((id) => !deletes.includes(id));
      return r.fulfill({ contentType: "application/json", headers: h, body: JSON.stringify({ active: ids }) });
    });
    return { posts, deletes };
  }

  test("set an alert for a whole car park, see it, stop it", async ({ page, context, api: _ }, info) => {
    test.skip(info.project.name === "iphone", "iPhone Safari needs the app installed; covered below");
    await context.grantPermissions(["notifications"]);
    const { posts, deletes } = await mockAlerts(page);
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
    await page.getByRole("button", { name: "Charger alerts" }).click();
    const panel = page.locator(".alert-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("radio", { name: "Is taken" }).click();
    await panel.getByRole("button", { name: "2 h" }).click();
    await panel.getByRole("button", { name: "Start alert" }).click();
    await expect(page.locator("#toast")).toContainText("Alert on: any charger is taken at Clarke Quay, for 2 h.");
    expect(posts).toHaveLength(1);
    const total = clarke.points.reduce((n, p) => n + p.plugs.reduce((m, pl) => m + pl.connectors.length, 0), 0);
    expect(posts[0]).toMatchObject({ station: clarke.id, name: "Clarke Quay", event: 0, minutes: 120, once: true, subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/test" } });
    expect(posts[0].connectors).toHaveLength(total);
    await expect(page.getByRole("button", { name: "Charger alerts" })).toHaveClass(/is-on/);
    await expect(page.locator(".watching")).toContainText("Any charger is taken");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#watch-list")).toContainText("Clarke Quay");
    await page.locator("#watch-list").getByRole("button", { name: "Stop" }).click();
    await expect(page.locator("#watch-list")).toContainText("No alerts");
    expect(deletes).toEqual(["watch-id-0000000001"]);
  });

  test("watch a single charger after tapping it", async ({ page, context, api: _ }, info) => {
    test.skip(info.project.name === "iphone", "iPhone Safari needs the app installed");
    await context.grantPermissions(["notifications"]);
    const { posts } = await mockAlerts(page);
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await page.locator("#view-detail button.cell").first().click();
    await page.getByRole("button", { name: "Charger alerts" }).click();
    const panel = page.locator(".alert-panel");
    await expect(panel.getByRole("radio", { name: /^L\d/ })).toHaveAttribute("aria-checked", "true");
    await panel.getByRole("button", { name: "Stop after the first alert" }).click(); // keep alerting
    await panel.getByRole("button", { name: "Start alert" }).click();
    await expect(page.locator(".watching")).toContainText(/L\d.* frees up/);
    expect(posts[0].connectors).toHaveLength(1);
    expect(posts[0]).toMatchObject({ event: 1, minutes: 60, once: false });
    expect(Object.keys(posts[0].labels as object)).toEqual(posts[0].connectors);
  });

  test("owner key: saved in Settings, unlocks 'Always', sent with the alert", async ({ page, context, api: _ }, info) => {
    test.skip(info.project.name === "iphone", "iPhone Safari needs the app installed");
    await context.grantPermissions(["notifications"]);
    const { posts } = await mockAlerts(page);
    const headers: string[] = [];
    await page.route("**/v1/owner", (r) => {
      const k = r.request().headers()["x-owner-key"] ?? "";
      return r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "X-Owner-Key" }, body: JSON.stringify({ owner: k === "my-owner-key-123" }) });
    });
    page.on("request", (req) => req.url().includes("/v1/watch") && req.method() === "POST" && headers.push(req.headers()["x-owner-key"] ?? ""));
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await page.getByRole("button", { name: "Charger alerts" }).click();
    await expect(page.locator(".alert-panel").getByRole("button", { name: "Always" })).toHaveCount(0); // not without the key
    await page.getByRole("button", { name: "Charger alerts" }).click();

    await page.getByRole("button", { name: "Settings" }).click();
    const owner = page.locator("#owner");
    await owner.getByLabel("Owner key").fill("wrong-key-000000");
    await owner.getByRole("button", { name: "Save" }).click();
    await expect(owner.locator(".owner__msg")).toContainText("That owner key isn't right");
    await owner.getByLabel("Owner key").fill("short");
    await owner.getByRole("button", { name: "Save" }).click();
    await expect(owner.locator(".owner__msg")).toHaveText("The owner key is at least 12 characters.");
    await owner.getByLabel("Owner key").fill("my-owner-key-123");
    await owner.getByRole("button", { name: "Save" }).click();
    await expect(owner).toContainText("Owner key saved on this device");
    await expect(owner.locator(".owner__msg")).toContainText("Owner key accepted");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Charger alerts" }).click();
    const panel = page.locator(".alert-panel");
    await panel.getByRole("button", { name: "Always" }).click();
    await panel.getByRole("button", { name: "Start alert" }).click();
    await expect(page.locator("#toast")).toContainText("until you stop it");
    expect(posts.at(-1)).toMatchObject({ minutes: 0 });
    expect(headers.at(-1)).toBe("my-owner-key-123");
  });

  test("iPhone without Home Screen install explains how to get alerts", async ({ page, api: _ }, info) => {
    test.skip(info.project.name !== "iphone", "iPhone only");
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await page.getByRole("button", { name: "Charger alerts" }).click();
    await expect(page.locator(".alert-panel__note")).toContainText("Add to Home Screen");
    await expect(page.getByRole("button", { name: "Start alert" })).toBeDisabled();
  });
});

test.describe("system Back button", () => {
  test("closes one layer at a time and never leaves the app", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.locator(".card").first().click();
    await expect(page.locator("#view-detail")).toBeVisible();
    await expect(page).toHaveURL(/#s=/);

    await page.getByRole("button", { name: "Charger alerts" }).click();
    await expect(page.locator(".alert-panel")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".alert-panel")).toHaveCount(0);
    await expect(page.locator("#view-detail")).toBeVisible();

    await page.goBack();
    await expect(page.locator("#view-detail")).toBeHidden();
    await expect(page.locator("#view-list")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#settings")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#settings")).toBeHidden();
    await expect(page.locator(".card").first()).toBeVisible(); // still in the app
  });

  test("a shared station link goes back to the map, not out of the app", async ({ page, api: _ }) => {
    await page.goto(`/#s=${encodeURIComponent(clarke.id)}`);
    await expect(page.locator("#view-detail h2")).toHaveText("Clarke Quay");
    await page.goBack();
    await expect(page.locator("#view-detail")).toBeHidden();
    await expect(page.locator(".card").first()).toBeVisible();
  });

  test("closing with on-screen buttons doesn't pile up history", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    const start = await page.evaluate(() => history.length);
    for (let i = 0; i < 3; i++) {
      await page.locator(".card").first().click();
      await expect(page.locator("#view-detail")).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#view-detail")).toBeHidden();
    }
    await page.waitForTimeout(300);
    // Each station open/close nets zero; the pulled-up list keeps its own one step (forward entries may remain).
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(start + 2);
    await page.goBack();
    await page.waitForTimeout(300);
    await expect(page.locator("#view-detail")).toBeHidden(); // Back doesn't resurrect a closed station
  });
});

test.describe("Back on the base screen", () => {
  test("a pulled-up list collapses to show the map", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.locator(".sheet__grip").click(); // peek -> half
    await expect(page.locator("#sheet")).not.toHaveAttribute("data-snap", "peek");
    await page.goBack();
    await expect(page.locator("#sheet")).toHaveAttribute("data-snap", "peek");
    await expect(page.locator(".card").first()).toBeAttached(); // still in the app
  });

  test("asks before leaving, and a second Back leaves", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.goBack();
    await expect(page.locator("#toast")).toHaveText("Press back again to exit");
    expect(new URL(page.url()).pathname).toBe("/"); // still here
    await page.goBack(); // within the window: leaves
    await expect.poll(() => page.url()).not.toContain("localhost:4173/");
  });

  test("if you don't press again, the next Back asks again", async ({ page, api: _ }) => {
    await page.goto("/");
    await ready(page);
    await page.goBack();
    await expect(page.locator("#toast")).toHaveText("Press back again to exit");
    await page.waitForTimeout(2800);
    await page.goBack();
    await expect(page.locator("#toast")).toHaveText("Press back again to exit");
    expect(page.url()).toContain("localhost:4173/");
  });
});
