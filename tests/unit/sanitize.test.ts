import { describe, expect, it } from "vitest";
import { sanitizePayload } from "../../src/api.ts";

describe("sanitizePayload (QA #8)", () => {
  it("coerces hostile or mistyped fields into safe primitives", () => {
    const out = sanitizePayload({
      v: 1,
      feedUpdated: null,
      fetchedAt: "x",
      stations: [
        {
          id: 5 as unknown as string,
          name: "<img src=x onerror=alert(1)>",
          address: null as unknown as string,
          postal: "",
          lat: "1.3" as unknown as number,
          lng: "javascript:alert(1)" as unknown as number,
          points: [],
        },
        {
          id: "ok",
          name: "A",
          address: "",
          postal: "",
          lat: 1.3,
          lng: 103.8,
          points: [{ operator: "X", position: "", hours: "", plugs: [{ type: "T2", current: "<b>" as "AC", kw: "50" as unknown as number, price: {} as unknown as number, priceType: "kWh", connectors: [{ id: "c", s: "1" as unknown as 1 }] }] }],
        },
      ],
    });
    // Non-numeric coordinates drop the station entirely.
    expect(out.stations).toHaveLength(1);
    const pl = out.stations[0].points[0].plugs[0];
    expect(pl.current).toBe("");
    expect(pl.kw).toBe(50);
    expect(pl.price).toBeNull();
    expect(pl.connectors[0].s).toBeNull();
  });
});
