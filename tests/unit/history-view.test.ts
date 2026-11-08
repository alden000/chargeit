import { describe, expect, it } from "vitest";
import type { ConnectorHistory } from "../../src/api.ts";
import { busiestWindow, clock, connectorStory, dayProfile, formatDuration, sgtParts, shortDuration, tileFacts } from "../../src/history-view.ts";

const NOW = Date.parse("2026-11-08T06:30:00Z"); // Sun 14:30 SGT
const min = (m: number) => m * 60_000;
const hist = (o: Partial<ConnectorHistory>): ConnectorHistory => ({ s: 0, since: null, sinceBefore: null, last: null, busy: [], ...o });

describe("history wording", () => {
  it("formats durations", () => {
    expect(formatDuration(min(0.4))).toBe("under a minute");
    expect(formatDuration(min(25))).toBe("25 min");
    expect(formatDuration(min(80))).toBe("1 h 20 min");
    expect(formatDuration(min(120))).toBe("2 h");
    expect(formatDuration(min(60 * 27))).toBe("1 d 3 h");
    expect(shortDuration(min(80))).toBe("1h 20m");
    expect(shortDuration(min(0.2))).toBe("<1m");
  });

  it("shows Singapore clock times, with the day when it isn't today", () => {
    expect(sgtParts(NOW)).toEqual({ day: 6, hour: 14 });
    expect(clock(NOW - min(25), NOW)).toBe("14:05");
    expect(clock(Date.parse("2026-11-07T10:00:00Z"), NOW)).toBe("Sat 18:00");
    expect(clock(Date.parse("2026-10-25T10:00:00Z"), NOW)).toBe("25 Oct");
  });
});

describe("charger tiles", () => {
  it("exact start: duration and start time", () => {
    expect(tileFacts(0, hist({ since: NOW - min(80) }), NOW)).toEqual({ dur: "1h 20m", atLeast: false, since: "since 13:10" });
  });

  it("started before we saw it: a minimum duration and no start time", () => {
    expect(tileFacts(1, hist({ s: 1, sinceBefore: NOW - min(95) }), NOW)).toEqual({ dur: "1h 35m", atLeast: true, since: null });
  });

  it("says nothing when history disagrees with the live status or is missing", () => {
    expect(tileFacts(1, hist({ since: NOW - min(80) }), NOW)).toEqual({ dur: null, atLeast: false, since: null });
    expect(tileFacts(0, null, NOW).dur).toBeNull();
    expect(tileFacts(null, hist({}), NOW).dur).toBeNull();
  });
});

describe("charger story (tap)", () => {
  it("tells current and previous sessions, exact or at-least", () => {
    expect(connectorStory(0, hist({ since: NOW - min(80), last: { start: NOW - min(200), startBefore: null, end: NOW - min(110) } }), NOW)).toEqual([
      "In use since 13:10 (1 h 20 min).",
      "Previous session 11:10–12:40 (1 h 30 min).",
    ]);
    expect(connectorStory(1, hist({ s: 1, sinceBefore: NOW - min(95), last: { start: null, startBefore: NOW - min(300), end: NOW - min(200) } }), NOW)).toEqual([
      "Free for at least 1 h 35 min (since before 12:55).",
      "Previous session ended 11:10, after at least 1 h 40 min.",
    ]);
    expect(connectorStory(1, hist({ since: NOW - min(80) }), NOW)).toEqual([]); // live disagrees
  });
});

describe("busy hours", () => {
  it("averages across chargers and names the busiest window", () => {
    const busy = (peak: number) => Array.from({ length: 168 }, (_, k) => (k % 24 === peak ? 90 : 10));
    const h = { at: NOW, from: NOW, connectors: { a: hist({ s: 1, busy: busy(19) }), b: null } };
    const p = dayProfile(h, ["a", "b"], 6);
    expect(p[19]).toBe(90);
    expect(p[3]).toBe(10);
    expect(busiestWindow(p)).toBe("Busiest 6pm–9pm");
    expect(busiestWindow(Array(24).fill(5))).toBe("Usually quiet");
    expect(busiestWindow(Array(24).fill(null))).toBeNull();
  });
});
