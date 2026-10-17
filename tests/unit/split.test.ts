import { describe, expect, it } from "vitest";
import type { ChargersPayload } from "../../shared/schema.ts";
import { applyStatus, layoutKey, statusString, stripStatusJson } from "../../shared/split.ts";

const full: ChargersPayload = {
  v: 1,
  feedUpdated: "2026-10-17T05:05:00.000Z",
  fetchedAt: "2026-10-17T05:05:30.000Z",
  stations: [
    {
      id: "a", name: 'He said "s":1} here', address: "", postal: "", lat: 1.3, lng: 103.8,
      points: [{ operator: "SP", position: "", hours: "", plugs: [
        { type: "Type 2", current: "AC", kw: 22, price: 0.5, priceType: "kWh", connectors: [{ id: "1", s: 1 }, { id: "2", s: 0 }] },
        { type: "CCS2", current: "DC", kw: 60, price: null, priceType: "", connectors: [{ id: "3", s: null }] },
      ] }],
    },
  ],
};

describe("stations/status split", () => {
  const stripped = JSON.parse(stripStatusJson(JSON.stringify(full.stations)));
  const stations = { v: 1 as const, sv: "x", cv: "c", stations: stripped };
  const status = { v: 1 as const, sv: "x", cv: "c", feedUpdated: full.feedUpdated, fetchedAt: full.fetchedAt, s: statusString(full.stations) };

  it("encodes one character per connector", () => expect(status.s).toBe("10-"));

  it("strips availability without touching text that merely looks like it", () => {
    expect(stripped[0].name).toBe('He said "s":1} here');
    expect(stripped[0].points[0].plugs[0].connectors).toEqual([{ id: "1", s: null }, { id: "2", s: null }]);
  });

  it("recombines to exactly the original", () => expect(applyStatus(stations, status)).toEqual(full));

  it("rejects a status for other stations, or of the wrong length", () => {
    expect(applyStatus(stations, { ...status, sv: "y" })).toBeNull();
    expect(applyStatus(stations, { ...status, s: "10" })).toBeNull();
    expect(applyStatus(stations, { ...status, s: "10-1" })).toBeNull();
  });

  it("layout ignores names, coordinates and prices but not chargers", () => {
    const moved = structuredClone(full.stations);
    moved[0].name = "Renamed";
    moved[0].lat += 0.001;
    moved[0].points[0].plugs[0].price = 0.9;
    expect(layoutKey(moved)).toBe(layoutKey(full.stations));
    moved[0].points[0].plugs[0].connectors.push({ id: "9", s: 1 });
    expect(layoutKey(moved)).not.toBe(layoutKey(full.stations));
  });
});
