import { describe, expect, it } from "vitest";
import type { Station } from "../../shared/schema.ts";
import {
  DEFAULT_FILTERS,
  availabilityText,
  distanceM,
  formatDistance,
  formatKw,
  formatPrice,
  groupPlugs,
  matchesFilters,
  operatorInfo,
  plugLabel,
  prettyName,
  searchStations,
  speedTier,
  summarize,
  timeAgo,
  toViewModels,
} from "../../src/model.ts";

function station(statuses: Array<0 | 1 | null>, over: Partial<Station> = {}, kw = 22, current: "AC" | "DC" = "AC", operator = "CHARGE+ PTE. LTD."): Station {
  return {
    id: over.id ?? "s1",
    name: "TEST MSCP",
    address: "1 TEST ROAD SINGAPORE 123456",
    postal: "123456",
    lat: 1.3,
    lng: 103.8,
    points: [
      {
        operator,
        position: "L1",
        hours: "",
        plugs: [{ type: current === "DC" ? "Combo 2" : "Type 2", current, kw, price: 0.65, priceType: "kWh", connectors: statuses.map((s, i) => ({ id: `c${i}`, s })) }],
      },
    ],
    ...over,
  };
}

describe("summarize", () => {
  it("counts free / busy / offline and derives state", () => {
    expect(summarize(station([1, 1, 0])).state).toBe("free");
    expect(summarize(station([0, 0])).state).toBe("busy");
    expect(summarize(station([null, null])).state).toBe("offline");
    expect(summarize(station([1, 0, 0, 0])).state).toBe("few");
    const s = summarize(station([1, 0, null]));
    expect(s).toMatchObject({ free: 1, busy: 1, offline: 1, total: 3, ratio: 0.5 });
  });
  it("tracks max power, DC, plug types and min price", () => {
    const st = station([1]);
    st.points.push({ operator: "SHELL", position: "", hours: "", plugs: [{ type: "Combo 2", current: "DC", kw: 120, price: null, priceType: "", connectors: [] }] });
    const s = summarize(st);
    expect(s).toMatchObject({ maxKw: 120, tier: 3, hasDC: true, minPrice: 0.65 });
    expect(s.plugTypes.sort()).toEqual(["CCS2", "Type 2"]);
  });
});

describe("formatting", () => {
  it("speed tiers", () => {
    expect([null, 3.7, 7.4, 11, 22, 49.9, 50, 350].map(speedTier)).toEqual([0, 1, 1, 2, 2, 2, 3, 3]);
  });
  it("prices", () => {
    expect(formatPrice({ price: 0.6976, priceType: "kWh" })).toEqual({ text: "$0.70", unit: "/kWh", kind: "paid" });
    expect(formatPrice({ price: 0, priceType: "free" }).kind).toBe("free");
    expect(formatPrice({ price: null, priceType: "" }).text).toBe("Price not listed");
  });
  it("kW and distances", () => {
    expect(formatKw(7.4)).toBe("7.4 kW");
    expect(formatKw(50)).toBe("50 kW");
    expect(formatKw(null)).toBe("— kW");
    expect(formatDistance(3)).toBe("10 m");
    expect(formatDistance(349)).toBe("350 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatDistance(23456)).toBe("23 km");
  });
  it("availability text", () => {
    expect(availabilityText(summarize(station([1, 0])))).toBe("1/2 free");
    expect(availabilityText(summarize(station([0, 0])))).toBe("All 2 in use");
    expect(availabilityText(summarize(station([null])))).toBe("Out of service");
  });
  it("plug labels", () => {
    expect(plugLabel("Combo 2")).toBe("CCS2");
    expect(plugLabel("CHAdeMO")).toBe("CHAdeMO");
    expect(plugLabel("Type 2")).toBe("Type 2");
  });
  it("operator names", () => {
    expect(operatorInfo("COMFORTDELGRO ENGIE PTE. LTD.").name).toBe("CDG ENGIE");
    expect(operatorInfo("SP MOBILITY PTE. LTD.").short).toBe("SP");
    expect(operatorInfo("TESLA MOTORS SINGAPORE PRIVATE LIMITED").name).toBe("Tesla");
    const unknown = operatorInfo("ACME CHARGING PTE. LTD.");
    expect(unknown.name).toBe("Acme Charging");
    expect(unknown.short).toBe("AC");
    // Must not mis-match substrings.
    expect(operatorInfo("PARKED POWER PTE LTD").name).toBe("Parked Power");
  });
  it("pretty names", () => {
    expect(prettyName("BLK 142A PASIR RIS STREET 11 MULTI STOREY CAR PARK")).toBe("Blk 142A Pasir Ris Street 11 Multi Storey Car Park");
    expect(prettyName("11TH AVENUE MSCP")).toBe("11th Avenue MSCP");
    expect(prettyName("Mixed Case Stays")).toBe("Mixed Case Stays");
  });
  it("timeAgo", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    expect(timeAgo("2026-01-01T00:09:50Z", now)).toBe("just now");
    expect(timeAgo("2026-01-01T00:05:00Z", now)).toBe("5 min ago");
    expect(timeAgo(null, now)).toBe("unknown");
  });
});

describe("geo", () => {
  it("haversine distance is about right", () => {
    // Clarke Quay → Raffles Place MRT ≈ 0.9 km
    const d = distanceM({ lat: 1.290314, lng: 103.846728 }, { lat: 1.283933, lng: 103.851463 });
    expect(d).toBeGreaterThan(800);
    expect(d).toBeLessThan(1000);
  });
});

describe("filters & search", () => {
  const vms = toViewModels({
    v: 1,
    feedUpdated: null,
    fetchedAt: new Date().toISOString(),
    stations: [
      station([1, 1], { id: "a", name: "ALPHA MALL" }),
      station([0], { id: "b", name: "BETA TOWER", postal: "555111" }, 120, "DC", "SHELL SINGAPORE PTE. LTD."),
      station([null], { id: "c", name: "GAMMA HUB" }, 7.4),
    ],
  });
  it("applies each filter", () => {
    const run = (f: Partial<typeof DEFAULT_FILTERS>, favs = new Set<string>()) => vms.filter((s) => matchesFilters(s, { ...DEFAULT_FILTERS, ...f }, favs)).map((s) => s.id);
    expect(run({})).toEqual(["a", "b", "c"]);
    expect(run({ freeNow: true })).toEqual(["a"]);
    expect(run({ dc: true })).toEqual(["b"]);
    expect(run({ minKw: 22 })).toEqual(["a", "b"]);
    expect(run({ minKw: 100 })).toEqual(["b"]);
    expect(run({ operators: ["Shell Recharge"] })).toEqual(["b"]);
    expect(run({ favourites: true }, new Set(["c"]))).toEqual(["c"]);
  });
  it("searches name, postal code and provider", () => {
    expect(searchStations(vms, "beta").map((s) => s.id)).toEqual(["b"]);
    expect(searchStations(vms, "555111").map((s) => s.id)).toEqual(["b"]);
    expect(searchStations(vms, "shell").map((s) => s.id)).toEqual(["b"]);
    expect(searchStations(vms, "charge+").map((s) => s.id).sort()).toEqual(["a", "c"]);
    expect(searchStations(vms, "   ")).toEqual([]);
  });
  it("groups plugs fastest-first", () => {
    const st = station([1, 0]);
    st.points.push({ operator: "X", position: "L2", hours: "", plugs: [{ type: "Combo 2", current: "DC", kw: 120, price: 0.8, priceType: "kWh", connectors: [{ id: "d", s: 1 }] }] });
    const g = groupPlugs(st);
    expect(g.map((x) => x.kw)).toEqual([120, 22]);
    expect(g[1].connectors).toHaveLength(2);
  });
});
