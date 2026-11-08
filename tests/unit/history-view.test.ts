import { describe, expect, it } from "vitest";
import { busiestWindow, clock, connectorStory, dayProfile, formatDuration, sgtParts, shortDuration, tileDuration } from "../../src/history-view.ts";

const NOW = Date.parse("2026-11-08T06:30:00Z"); // Sun 14:30 SGT
const min = (m: number) => m * 60_000;

describe("history wording", () => {
  it("formats durations", () => {
    expect(formatDuration(min(0.4))).toBe("under a minute");
    expect(formatDuration(min(25))).toBe("25 min");
    expect(formatDuration(min(80))).toBe("1 h 20 min");
    expect(formatDuration(min(120))).toBe("2 h");
    expect(formatDuration(min(60 * 27))).toBe("1 d 3 h");
    expect(shortDuration(min(80))).toBe("1h 20m");
  });

  it("shows Singapore clock times, with the day when it isn't today", () => {
    expect(sgtParts(NOW)).toEqual({ day: 6, hour: 14 });
    expect(clock(NOW - min(25), NOW)).toBe("14:05");
    expect(clock(Date.parse("2026-11-07T10:00:00Z"), NOW)).toBe("Sat 18:00");
  });

  it("tells a charger's story only when history agrees with the live status", () => {
    const h = { s: 0 as const, since: NOW - min(80), last: { start: NOW - min(200), end: NOW - min(110) }, busy: [] };
    expect(connectorStory(0, h, NOW)).toEqual(["In use since 13:10 (1 h 20 min).", "Previous session 11:10–12:40 (1 h 30 min)."]);
    expect(tileDuration(0, h, NOW)).toBe("1h 20m");
    expect(tileDuration(1, h, NOW)).toBeNull(); // live says free: don't contradict it
    expect(connectorStory(1, h, NOW)).toEqual(["Previous session 11:10–12:40 (1 h 30 min)."]);
    expect(connectorStory(1, { ...h, s: 1, since: null, last: { start: null, end: NOW - min(5) } }, NOW)).toEqual([
      "Free since before we started tracking it.",
      "Previous session ended 14:25.",
    ]);
  });

  it("averages busy hours across chargers and names the busiest window", () => {
    const busy = (peak: number) => Array.from({ length: 168 }, (_, k) => (k % 24 === peak ? 90 : 10));
    const hist = { at: NOW, from: NOW, connectors: { a: { s: 1 as const, since: null, last: null, busy: busy(19) }, b: null } };
    const p = dayProfile(hist, ["a", "b"], 6);
    expect(p[19]).toBe(90);
    expect(p[3]).toBe(10);
    expect(busiestWindow(p)).toBe("Usually busiest 5pm–8pm");
    expect(busiestWindow(Array(24).fill(5))).toBe("Usually quiet all day");
    expect(busiestWindow(Array(24).fill(null))).toBeNull();
  });
});

import { tileFacts } from "../../src/history-view.ts";

describe("charger tile facts", () => {
  const h = { s: 0 as const, since: NOW - min(80), last: { start: NOW - min(200), end: NOW - min(110) }, busy: [] };
  it("duration, start time and previous session fit in the tile", () => {
    expect(tileFacts(0, h, NOW - min(600), NOW)).toEqual({ dur: "1h 20m", since: "since 13:10", prev: "prev 1h 30m" });
  });
  it("unknown start says since when we've been watching; disagreement hides current-state facts", () => {
    expect(tileFacts(0, { ...h, since: null, last: null }, Date.parse("2026-11-08T02:55:00Z"), NOW)).toEqual({ dur: null, since: "before 10:55", prev: null });
    expect(tileFacts(1, h, null, NOW)).toEqual({ dur: null, since: null, prev: "prev 1h 30m" });
    expect(tileFacts(0, { ...h, last: { start: null, end: NOW - min(5) } }, null, NOW).prev).toBe("prev ended 14:25");
  });
});
