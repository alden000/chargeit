import { describe, expect, it } from "vitest";
import { matchAlerts, parseWatch, type WatchRow } from "../../worker/src/alerts.ts";

const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BPub", auth: "secret" } };
const ok = { subscription: sub, station: "532002", name: "Multi Storey Car Park", connectors: ["R1-001", "R1-002"], labels: { "R1-001": "L3A 82" }, event: 1, minutes: 60, once: true };

describe("alerts: watch requests", () => {
  it("accepts a well-formed watch", () => {
    expect(parseWatch(ok)).toMatchObject({ station: "532002", event: 1, minutes: 60, once: true, connectors: ["R1-001", "R1-002"], labels: { "R1-001": "L3A 82" } });
  });

  it("rejects anything that isn't a real push service, a known shape, or a sane duration", () => {
    expect(parseWatch({ ...ok, subscription: { ...sub, endpoint: "https://evil.example/x" } })).toBe("invalid push subscription");
    expect(parseWatch({ ...ok, station: "../etc" })).toBe("invalid station");
    expect(parseWatch({ ...ok, connectors: [] })).toBe("invalid connectors");
    expect(parseWatch({ ...ok, connectors: ["<script>"] })).toBe("invalid connectors");
    expect(parseWatch({ ...ok, event: 3 })).toBe("invalid event");
    expect(parseWatch({ ...ok, minutes: 5 })).toBe("invalid duration");
    expect(parseWatch({ ...ok, minutes: 24 * 60 })).toBe("invalid duration");
    expect(parseWatch(null)).toBe("body must be an object");
  });

  it("trims long names and labels", () => {
    const w = parseWatch({ ...ok, name: "x".repeat(150), labels: { "R1-001": "y".repeat(60) } });
    expect(typeof w === "object" && [w.name.length, w.labels["R1-001"].length]).toEqual([80, 24]);
  });
});

describe("alerts: matching changes to watches", () => {
  const row = (o: Partial<WatchRow>): WatchRow => ({
    id: "w1", endpoint: sub.endpoint, p256dh: "p", auth: "a", station: "532002", name: "Blk 532 MSCP",
    connectors: JSON.stringify(["R1-001", "R1-002", "R1-003"]), labels: JSON.stringify({ "R1-001": "L3A 82", "R1-002": "L3A 83" }),
    event: 1, once: 1, ...o,
  });

  it("alerts only on the watched transition, naming the lots", () => {
    const changed = new Map<string, 0 | 1>([["R1-001", 1], ["R1-003", 0], ["R9-001", 1]]);
    const [a] = matchAlerts([row({})], changed);
    expect(a.payload).toEqual({ title: "Charger free · Blk 532 MSCP", body: "L3A 82 is free now.", tag: "chargeit-w1", url: "./#s=532002" });
    expect(matchAlerts([row({ event: 0 })], changed)[0].payload.body).toBe("1 charger is taken now."); // R1-003 has no label
    expect(matchAlerts([row({})], new Map([["R9-001", 1 as const]]))).toEqual([]);
  });

  it("'either' reports frees and takes together", () => {
    const changed = new Map<string, 0 | 1>([["R1-001", 1], ["R1-002", 0]]);
    const [a] = matchAlerts([row({ event: 2 })], changed);
    expect(a.payload.title).toBe("Chargers changed · Blk 532 MSCP");
    expect(a.payload.body).toBe("L3A 82 is free; L3A 83 is taken now.");
    expect(matchAlerts([row({ event: 2 })], new Map([["R1-002", 0 as const]]))[0].payload.title).toBe("Charger taken · Blk 532 MSCP");
    expect(parseWatch({ ...ok, event: 2 })).toMatchObject({ event: 2 });
  });

  it("several at once, and broken rows are skipped", () => {
    const changed = new Map<string, 0 | 1>([["R1-001", 1], ["R1-002", 1]]);
    expect(matchAlerts([row({})], changed)[0].payload.body).toBe("L3A 82, L3A 83 are free now.");
    expect(matchAlerts([row({ connectors: "not json" })], changed)).toEqual([]);
  });
});
