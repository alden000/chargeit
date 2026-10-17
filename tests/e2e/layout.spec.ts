import { expect, ready, test } from "./fixtures.ts";

test("no horizontal overflow and touch targets meet WCAG 2.5.8 (≥ 24px)", async ({ page, api: _ }) => {
  await page.goto("/");
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a.btn, [role=button]")]
      .filter((el) => el.offsetParent !== null && !el.closest(".maplibregl-ctrl"))
      .map((el) => ({ el: el.className || el.id, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 24 || r.width < 24))
      .map(({ el, r }) => `${el} ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
});

test("every interactive control has an accessible name", async ({ page, api: _ }) => {
  await page.goto("/");
  await ready(page);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, input, [role=button], a")]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !(el.getAttribute("aria-label") || el.textContent?.trim() || el.getAttribute("title") || (el as HTMLInputElement).placeholder))
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
});

for (const width of [320, 360]) {
  test(`top bar fits a ${width}px phone: brand, live pill + countdown, settings`, async ({ page, api: _ }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await ready(page);
    await expect(page.locator("#live .live__next")).toBeVisible();
    const boxes = await page.evaluate(() =>
      ["a.brand", "#live", "#settings-btn"].map((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    const [brand, live, settings] = boxes;
    expect(settings.right).toBeLessThanOrEqual(width - 12); // keeps a side gutter
    expect(brand.right).toBeLessThanOrEqual(live.left);
    expect(live.right).toBeLessThanOrEqual(settings.left);
  });
}
