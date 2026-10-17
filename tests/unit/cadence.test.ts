import { describe, expect, it } from "vitest";
import { FEED_LAG_MS, FEED_PERIOD_MS, nextFeedAt } from "../../shared/cadence.ts";

const T = (iso: string) => Date.parse(iso);

describe("LTA feed cadence", () => {
  it("next snapshot is due 5 minutes after the current one, plus LTA's publish lag", () => {
    expect(nextFeedAt("2026-10-17T05:05:00.000Z", T("2026-10-17T05:06:10Z"))).toBe(T("2026-10-17T05:10:00Z") + FEED_LAG_MS);
  });

  it("falls back to the wall-clock 5-minute grid without a stamp", () => {
    expect(nextFeedAt(null, T("2026-10-17T05:07:00Z"))).toBe(T("2026-10-17T05:10:00Z") + FEED_LAG_MS);
    // Just after a mark but before the file is out: that mark's file is next.
    expect(nextFeedAt("garbage", T("2026-10-17T05:10:20Z"))).toBe(T("2026-10-17T05:10:00Z") + FEED_LAG_MS);
    expect(nextFeedAt(undefined, T("2026-10-17T05:10:50Z"))).toBe(T("2026-10-17T05:15:00Z") + FEED_LAG_MS);
    expect(FEED_PERIOD_MS).toBe(300_000);
  });
});
