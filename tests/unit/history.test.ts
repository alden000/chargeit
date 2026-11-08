import { describe, expect, it } from "vitest";
import { SINCE_EXACT, START_EXACT, accumulate, applyStatus, decodeState, emptyState, encodeChanges, encodeState, growState, slotOf, upgradeV1, type Slot } from "../../worker/src/history.ts";

const min = (iso: string) => Date.parse(iso) / 60_000;

describe("history: hour-of-week slots (Singapore time)", () => {
  it("Monday 00:xx SGT is slot 0, Sunday 23:xx is 167", () => {
    expect(slotOf(min("2026-11-08T16:30:00Z"))).toBe(0); // Mon 9 Nov 00:30 SGT
    expect(slotOf(min("2026-11-08T15:59:00Z"))).toBe(167); // Sun 8 Nov 23:59 SGT
    expect(slotOf(min("2026-10-17T07:05:00Z"))).toBe(5 * 24 + 15); // Sat 15:05 SGT
  });
});

describe("history: state transitions", () => {
  const idx = Uint32Array.from([0, 1, 2]);
  const t = (m: number) => 1_000_000 + m;

  it("first sighting is a lower bound; later changes are exact; sessions carry their start's exactness", () => {
    const st = growState(emptyState(), 3);
    expect(applyStatus(st, idx, "01-", t(0))).toEqual([[0, 0], [1, 1]]);
    expect([st.s[0], st.since[0], st.flags[0] & SINCE_EXACT, st.s[2]]).toEqual([0, t(0), 0, -1]);

    applyStatus(st, idx, "10-", t(5)); // 0 frees up (its session began at or before t0), 1 becomes busy
    expect([st.s[0], st.since[0], st.flags[0] & SINCE_EXACT, st.lastStart[0], st.flags[0] & START_EXACT, st.lastEnd[0]]).toEqual([1, t(5), SINCE_EXACT, t(0), 0, t(5)]);
    expect([st.s[1], st.since[1], st.flags[1] & SINCE_EXACT, st.lastEnd[1]]).toEqual([0, t(5), SINCE_EXACT, 0]);

    applyStatus(st, idx, "-1-", t(20)); // unknown leaves 0 alone; 1's 15-minute session ends, start exact
    expect(st.s[0]).toBe(1);
    expect([st.s[1], st.lastStart[1], st.flags[1] & START_EXACT, st.lastEnd[1], st.since[1]]).toEqual([1, t(5), START_EXACT, t(20), t(20)]);
    expect(st.lastFeed).toBe(t(20));
  });

  it("state survives encode/decode, including growth for new connectors", () => {
    let st = growState(emptyState(), 2);
    applyStatus(st, Uint32Array.from([0, 1]), "01", 42);
    applyStatus(st, Uint32Array.from([0, 1]), "11", 47);
    st = growState(decodeState(encodeState(st)), 5);
    expect(st.n).toBe(5);
    expect([...st.s]).toEqual([1, 1, -1, -1, -1]);
    expect([...st.flags]).toEqual([SINCE_EXACT, 0, 0, 0, 0]);
    expect([st.lastFeed, st.version]).toEqual([47, 2]);
    expect(decodeState(new Uint8Array([1, 2, 3]))).toEqual(emptyState());
  });

  it("upgrades v1 state: unknown starts become 'at or before first seen' from the change log", () => {
    // Hand-built v1 encoding: 3 connectors, lastFeed 30.
    const n = 3;
    const buf = new ArrayBuffer(12 + 4 + n * 12);
    new Uint32Array(buf, 0, 3).set([1, n, 30]);
    new Int8Array(buf, 12, n).set([0, 1, 0]);
    const u = (o: number) => new Uint32Array(buf, 16 + o * n * 4, n);
    u(0).set([0, 25, 0]); // since: 0 unknown, 25 exact, 0 unknown
    u(1).set([0, 0, 0]); // lastStart
    u(2).set([0, 25, 0]); // lastEnd: connector 1 had a session end at 25 (start unknown)
    const st = decodeState(new Uint8Array(buf));
    expect([st.version, ...st.flags]).toEqual([1, 0, SINCE_EXACT, 0]);
    upgradeV1(st, [
      { ts: 10, data: encodeChanges([[0, 0], [1, 0]]) },
      { ts: 20, data: encodeChanges([[2, 0]]) }, // connector 2 first seen later
      { ts: 25, data: encodeChanges([[1, 1]]) },
    ]);
    expect(st.version).toBe(2);
    expect([...st.since]).toEqual([10, 25, 20]);
    expect([...st.lastStart]).toEqual([0, 10, 0]);
    expect(st.flags[1] & START_EXACT).toBe(0);
  });

  it("change log encodes index + state in 5 bytes each", () => {
    const b = encodeChanges([[70_000, 1], [3, 0]]);
    expect(b.length).toBe(10);
    expect(new DataView(b.buffer).getUint32(0, true)).toBe(70_000);
    expect([b[4], b[9]]).toEqual([1, 0]);
  });
});

describe("history: busy-hour counters", () => {
  it("counts known samples, and halves at the cap so old weeks fade", () => {
    const slot: Slot = { busy: new Uint8Array(2), seen: new Uint8Array(2) };
    const idx = Uint32Array.from([0, 1]);
    for (let i = 0; i < 192; i++) accumulate(slot, idx, i % 4 ? "1-" : "0-");
    expect([slot.seen[0], slot.busy[0], slot.seen[1]]).toEqual([192, 48, 0]);
    accumulate(slot, idx, "0-");
    expect([slot.seen[0], slot.busy[0]]).toEqual([97, 25]);
  });
});
