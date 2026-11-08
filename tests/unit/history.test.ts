import { describe, expect, it } from "vitest";
import { accumulate, applyStatus, decodeState, emptyState, encodeChanges, encodeState, growState, slotOf, type Slot } from "../../worker/src/history.ts";

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

  it("first sighting has no known start; later changes are timed; sessions are recorded", () => {
    const st = growState(emptyState(), 3);
    expect(applyStatus(st, idx, "01-", t(0))).toEqual([[0, 0], [1, 1]]);
    expect([st.s[0], st.since[0], st.s[2]]).toEqual([0, 0, -1]);

    applyStatus(st, idx, "10-", t(5)); // 0 frees up (start unknown), 1 becomes busy
    expect([st.s[0], st.since[0], st.lastStart[0], st.lastEnd[0]]).toEqual([1, t(5), 0, t(5)]);
    expect([st.s[1], st.since[1], st.lastEnd[1]]).toEqual([0, t(5), 0]);

    applyStatus(st, idx, "-1-", t(20)); // unknown leaves 0 alone; 1's 15-minute session ends
    expect(st.s[0]).toBe(1);
    expect([st.s[1], st.lastStart[1], st.lastEnd[1], st.since[1]]).toEqual([1, t(5), t(20), t(20)]);
    expect(st.lastFeed).toBe(t(20));
  });

  it("state survives encode/decode, including growth for new connectors", () => {
    let st = growState(emptyState(), 2);
    applyStatus(st, Uint32Array.from([0, 1]), "01", 42);
    st = growState(decodeState(encodeState(st)), 5);
    expect(st.n).toBe(5);
    expect([...st.s]).toEqual([0, 1, -1, -1, -1]);
    expect(st.lastFeed).toBe(42);
    expect(decodeState(new Uint8Array([1, 2, 3]))).toEqual(emptyState());
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
