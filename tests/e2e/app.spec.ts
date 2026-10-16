import { clarke, expect, ready, snapshot, test } from "./fixtures.ts";

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

    await page.getByRole("button", { name: "Close" }).click();
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
    await page.getByRole("button", { name: "Close" }).click();
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
