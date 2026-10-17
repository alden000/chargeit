import { describe, expect, it } from "vitest";
import { findStations, hashId, normalizeBatch, parseStatus, toIsoSgt } from "../../shared/normalize.ts";

const rawStation = (over: Record<string, unknown> = {}) => ({
  address: "3E RIVER VALLEY ROAD SINGAPORE 179024",
  name: "CLARKE QUAY",
  longtitude: "103.846728", // LTA's own spelling
  latitude: "1.290314",
  postalCode: "179024",
  chargingPoints: [
    {
      status: "1",
      operatingHours: "",
      operator: "SP MOBILITY PTE. LTD.",
      position: "L4 51 & 52",
      plugTypes: [
        {
          plugType: "Combo 2",
          current: "DC",
          powerRating: "50",
          price: "0.8938",
          priceType: "kWh",
          evIds: [
            { evCpId: "R114858R-001", status: "1" },
            { evCpId: "R114858R-002", status: "0" },
          ],
        },
      ],
    },
    {
      status: "1",
      operator: "SP MOBILITY PTE. LTD.",
      position: "L4 49",
      plugTypes: [{ plugType: "Type 2", current: "AC", powerRating: "22", price: "", priceType: "", evIds: [{ evCpId: "X-1", status: "" }] }],
    },
  ],
  ...over,
});

describe("normalizeBatch", () => {
  it("normalises the live EVCBatch shape", () => {
    const out = normalizeBatch({ LastUpdatedTime: "2026-10-02 19:15:00", evLocationsData: [rawStation()] }, new Date("2026-10-02T11:16:00Z"));
    expect(out.v).toBe(1);
    expect(out.feedUpdated).toBe("2026-10-02T11:15:00.000Z");
    expect(out.fetchedAt).toBe("2026-10-02T11:16:00.000Z");
    expect(out.stations).toHaveLength(1);
    const st = out.stations[0];
    expect(st).toMatchObject({ name: "CLARKE QUAY", postal: "179024", lat: 1.290314, lng: 103.846728 });
    expect(st.points[0].plugs[0]).toEqual({
      type: "Combo 2",
      current: "DC",
      kw: 50,
      price: 0.8938,
      priceType: "kWh",
      connectors: [
        { id: "R114858R-001", s: 1 },
        { id: "R114858R-002", s: 0 },
      ],
    });
    // Missing price/status are null, not 0.
    expect(st.points[1].plugs[0]).toMatchObject({ price: null, connectors: [{ id: "X-1", s: null }] });
  });

  it("accepts evIds on the charge point (per-postal-code API shape) and a 'value' wrapper", () => {
    const st = rawStation();
    const cp = (st.chargingPoints as any[])[0];
    cp.evIds = cp.plugTypes[0].evIds;
    delete cp.plugTypes[0].evIds;
    const out = normalizeBatch({ value: { evLocationsData: [st], LastUpdatedTime: "2026-10-02 19:15" } });
    expect(out.stations[0].points[0].plugs[0].connectors).toHaveLength(2);
    expect(out.feedUpdated).toBe("2026-10-02T11:15:00.000Z");
  });

  it("drops stations outside Singapore or without coordinates, and skips junk records", () => {
    const out = normalizeBatch({
      evLocationsData: [rawStation({ latitude: "0", longtitude: "0" }), rawStation({ latitude: "" }), null, 42, rawStation({ chargingPoints: [] }), rawStation()],
    });
    expect(out.stations).toHaveLength(1);
  });

  it("gives every station a unique, stable, URL-safe id", () => {
    const a = normalizeBatch({ evLocationsData: [rawStation(), rawStation()] });
    const b = normalizeBatch({ evLocationsData: [rawStation(), rawStation()] });
    const ids = a.stations.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(b.stations.map((s) => s.id));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("never glues the digits of a kW range together (QA #5)", () => {
    const st = rawStation();
    const plug = (st.chargingPoints as any[])[0].plugTypes[0];
    plug.powerRating = "7.4 / 22";
    plug.price = "$0.65/kWh";
    const p = normalizeBatch({ evLocationsData: [st] }).stations[0].points[0].plugs[0];
    expect(p.kw).toBe(22);
    expect(p.price).toBe(0.65);
  });

  it("keeps station ids stable when LTA renames a site (QA #12)", () => {
    const a = normalizeBatch({ evLocationsData: [rawStation()] }).stations[0].id;
    const b = normalizeBatch({ evLocationsData: [rawStation({ name: "CLARKE QUAY (RENAMED)" })] }).stations[0].id;
    expect(a).toBe(b);
  });

  it("uses the postal code as the id, unmoved by LTA's coordinate/name flips", () => {
    const a = normalizeBatch({ evLocationsData: [rawStation()] }).stations[0].id;
    const b = normalizeBatch({ evLocationsData: [rawStation({ name: "IKEA ALEXANDRA", latitude: "1.2913", longtitude: "103.8471" })] }).stations[0].id;
    expect(a).toBe("179024");
    expect(b).toBe(a);
  });

  it("gives identical bytes whatever order LTA lists sites, points and connectors in", () => {
    const other = rawStation({ postalCode: "018956", name: "MARINA" });
    const shuffled = rawStation();
    (shuffled.chargingPoints as any[]).reverse();
    for (const pt of shuffled.chargingPoints as any[]) for (const pl of pt.plugTypes) pl.evIds.reverse();
    const a = normalizeBatch({ evLocationsData: [rawStation(), other] }, new Date(0));
    const b = normalizeBatch({ evLocationsData: [other, shuffled] }, new Date(0));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.stations.map((s) => s.id)).toEqual(["018956", "179024"]);
  });

  it("treats priceType 'free' as a zero price", () => {
    const st = rawStation();
    (st.chargingPoints as any[])[0].plugTypes[0].priceType = "Free";
    (st.chargingPoints as any[])[0].plugTypes[0].price = "";
    const p = normalizeBatch({ evLocationsData: [st] }).stations[0].points[0].plugs[0];
    expect(p).toMatchObject({ price: 0, priceType: "free" });
  });

  it("infers AC/DC from the plug type when `current` is missing", () => {
    const st = rawStation();
    delete (st.chargingPoints as any[])[0].plugTypes[0].current;
    expect(normalizeBatch({ evLocationsData: [st] }).stations[0].points[0].plugs[0].current).toBe("DC");
  });

  it("de-duplicates repeated connector ids", () => {
    const st = rawStation();
    const ev = (st.chargingPoints as any[])[0].plugTypes[0].evIds;
    ev.push({ ...ev[0] });
    expect(normalizeBatch({ evLocationsData: [st] }).stations[0].points[0].plugs[0].connectors).toHaveLength(2);
  });

  it("returns an empty list for unrecognisable input instead of throwing", () => {
    expect(normalizeBatch(null).stations).toEqual([]);
    expect(normalizeBatch("nope").stations).toEqual([]);
    expect(normalizeBatch({ foo: [{ bar: 1 }] }).stations).toEqual([]);
  });
});

describe("helpers", () => {
  it("parseStatus", () => {
    expect(parseStatus("1")).toBe(1);
    expect(parseStatus(1)).toBe(1);
    expect(parseStatus("0")).toBe(0);
    expect(parseStatus("")).toBeNull();
    expect(parseStatus("100")).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
  });
  it("toIsoSgt keeps SGT when the time has fractional seconds (QA #6)", () => {
    expect(toIsoSgt("2026-10-02 19:15:00.123")).toBe("2026-10-02T11:15:00.123Z");
    expect(toIsoSgt("2026-10-02T19:15:00+08:00")).toBe("2026-10-02T11:15:00.000Z");
  });
  it("toIsoSgt treats zone-less times as Singapore time", () => {
    expect(toIsoSgt("2026-01-01 08:00:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(toIsoSgt("2026-01-01T08:00:00Z")).toBe("2026-01-01T08:00:00.000Z");
    expect(toIsoSgt("garbage")).toBeNull();
    expect(toIsoSgt("")).toBeNull();
  });
  it("findStations searches nested containers", () => {
    expect(findStations({ a: { b: [{ chargingPoints: [] }] } })).toHaveLength(1);
  });
  it("hashId is deterministic", () => {
    expect(hashId("abc")).toBe(hashId("abc"));
    expect(hashId("abc")).not.toBe(hashId("abd"));
  });
});
