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
