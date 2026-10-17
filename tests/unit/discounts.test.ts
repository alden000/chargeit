import { describe, expect, it } from "vitest";
import type { Station } from "../../shared/schema.ts";
import { applyDiscount, bestPrice, clampPct, plugPrice, sanitizeDiscounts } from "../../src/model.ts";

const st: Station = {
  id: "s",
  name: "X",
  address: "",
  postal: "",
  lat: 1.3,
  lng: 103.8,
  points: [
    { operator: "SP MOBILITY PTE. LTD.", position: "", hours: "", plugs: [{ type: "Type 2", current: "AC", kw: 22, price: 0.8, priceType: "kWh", connectors: [] }] },
    { operator: "SHELL SINGAPORE PTE. LTD.", position: "", hours: "", plugs: [{ type: "Combo 2", current: "DC", kw: 120, price: 0.7, priceType: "kWh", connectors: [] }] },
  ],
};

describe("discounts", () => {
  it("clamps and rounds percentages", () => {
    expect(clampPct("15")).toBe(15);
    expect(clampPct("12,5")).toBe(12.5);
    expect(clampPct(12.345)).toBe(12.3);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct("abc")).toBe(0);
    expect(clampPct({})).toBe(0);
  });

  it("sanitises stored values", () => {
    expect(sanitizeDiscounts({ "SP Mobility": 10, Shell: "x", Bad: -1, "Shell Recharge": "20" })).toEqual({ "SP Mobility": 10, "Shell Recharge": 20 });
    expect(sanitizeDiscounts(["nope"])).toEqual({});
    expect(sanitizeDiscounts(null)).toEqual({});
  });

  it("applies the provider's discount by display name", () => {
    expect(applyDiscount(0.8, 25)).toBeCloseTo(0.6);
    const p = plugPrice(st.points[0].plugs[0], st.points[0].operator, { "SP Mobility": 25 });
    expect(p).toMatchObject({ original: 0.8, pct: 25 });
    expect(p!.price).toBeCloseTo(0.6);
    expect(plugPrice(st.points[0].plugs[0], st.points[0].operator, {})!.pct).toBe(0);
  });

  it("picks the cheapest price after discounts, which can change the winner", () => {
    expect(bestPrice(st, {})!.price).toBeCloseTo(0.7); // Shell cheaper at list price
    const b = bestPrice(st, { "SP Mobility": 25 })!; // SP becomes cheaper for this user
    expect(b.price).toBeCloseTo(0.6);
    expect(b.pct).toBe(25);
  });

  it("free stays free and missing prices stay missing", () => {
    expect(plugPrice({ price: 0, priceType: "free" }, "X", { X: 50 })!.price).toBe(0);
    expect(plugPrice({ price: null, priceType: "" }, "X", {})).toBeNull();
  });
});

import { DEFAULT_FILTERS, bestKwhPrice, matchesFilters, toViewModels } from "../../src/model.ts";

describe("price filter", () => {
  const mk = (id: string, price: number | null, priceType = "kWh", operator = "SHELL SINGAPORE PTE. LTD.") => ({
    id, name: id, address: "", postal: "", lat: 1.3, lng: 103.8,
    points: [{ operator, position: "", hours: "", plugs: [{ type: "Type 2", current: "AC" as const, kw: 22, price, priceType, connectors: [{ id: "c", s: 1 as const }] }] }],
  });
  const vms = toViewModels({ v: 1, feedUpdated: null, fetchedAt: "", stations: [mk("cheap", 0.5), mk("dear", 0.9), mk("none", null, ""), mk("free", 0, "free"), mk("sp", 0.8, "kWh", "SP MOBILITY PTE. LTD.")] });
  const run = (maxPrice: number | null, discounts = {}) => vms.filter((s) => matchesFilters(s, { ...DEFAULT_FILTERS, maxPrice }, new Set(), discounts)).map((s) => s.id);

  it("Any price shows everything, including unlisted", () => {
    expect(run(null)).toEqual(["cheap", "dear", "none", "free", "sp"]);
  });
  it("a max price hides dearer and unlisted stations, keeps free", () => {
    expect(run(0.6)).toEqual(["cheap", "free"]);
    expect(run(0.9)).toEqual(["cheap", "dear", "free", "sp"]);
    expect(run(0)).toEqual(["free"]);
  });
  it("uses the price after the user's discount", () => {
    expect(run(0.6, { "SP Mobility": 25 })).toEqual(["cheap", "free", "sp"]); // 0.80 → 0.60
  });
  it("bestKwhPrice ignores non-kWh units", () => {
    expect(bestKwhPrice(mk("x", 2, "hour"), {})).toBeNull();
    expect(bestKwhPrice(mk("y", 0.7), {})).toBe(0.7);
  });
});

import { plugFilter, tierLabel } from "../../src/model.ts";

describe("filters match per charger, not per site", () => {
  // Koufu-like site: cheap 22 kW AC, pricier DC — the user's reported case.
  const site: Station = {
    id: "mixed", name: "Mixed", address: "", postal: "", lat: 1.3, lng: 103.8,
    points: [
      { operator: "SP MOBILITY PTE. LTD.", position: "", hours: "", plugs: [{ type: "Type 2", current: "AC", kw: 22, price: 0.7, priceType: "kWh", connectors: [{ id: "a", s: 1 }] }] },
      { operator: "SP MOBILITY PTE. LTD.", position: "", hours: "", plugs: [{ type: "CCS2", current: "DC", kw: 60, price: 0.7625, priceType: "kWh", connectors: [{ id: "b", s: 0 }] }] },
    ],
  };
  const [vm] = toViewModels({ v: 1, feedUpdated: null, fetchedAt: "", stations: [site] });
  const sp = { "SP Mobility": 20 }; // AC → $0.56, DC → $0.61
  const ok = (f: Partial<typeof DEFAULT_FILTERS>) => matchesFilters(vm, { ...DEFAULT_FILTERS, ...f }, new Set(), sp);

  it("DC + price needs one DC charger within price", () => {
    expect(ok({ maxPrice: 0.56 })).toBe(true); // the AC charger qualifies
    expect(ok({ dc: true })).toBe(true);
    expect(ok({ dc: true, maxPrice: 0.56 })).toBe(false);
    expect(ok({ dc: true, maxPrice: 0.61 })).toBe(true);
  });

  it("speed and free-now are per charger too", () => {
    expect(ok({ minKw: 50, maxPrice: 0.56 })).toBe(false);
    expect(ok({ freeNow: true })).toBe(true); // AC is free
    expect(ok({ freeNow: true, dc: true })).toBe(false); // DC is busy
  });

  it("prices shown come from matching chargers", () => {
    expect(bestKwhPrice(vm, sp)).toBeCloseTo(0.56);
    expect(bestKwhPrice(vm, sp, plugFilter({ ...DEFAULT_FILTERS, dc: true }, sp))).toBeCloseTo(0.61);
    expect(bestPrice(vm, sp, plugFilter({ ...DEFAULT_FILTERS, dc: true }, sp))!.price).toBeCloseTo(0.61);
    expect(plugFilter(DEFAULT_FILTERS)).toBeUndefined();
  });

  it("22 kW AC reads Standard, not Fast", () => {
    expect(tierLabel(2)).toBe("Standard");
    expect(tierLabel(2, true)).toBe("Fast");
    expect(tierLabel(3)).toBe("Rapid");
    expect(tierLabel(1)).toBe("Slow");
  });
});
