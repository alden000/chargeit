/**
 * Per-charger history, recorded from every LTA snapshot by the cron trigger.
 *
 * Kept deliberately small so each run costs a handful of D1 rows, not one per
 * charger (Workers Free allows 100k rows written a day):
 *
 *   kv 'ids'    connector ids, append-only; a connector's index is its position
 *   kv 'state'  per connector: current state, since when, and its last session
 *   slots       per hour of the week: per connector, samples seen / seen in use
 *   changes     per snapshot: which connectors changed, for later reprocessing
 *
 * A run reads 3 rows and writes 3–4. Times are minutes since the Unix epoch.
 * States: 1 free, 0 in use, -1 not known yet. A snapshot that doesn't report a
 * connector ("-") leaves its state as it was.
 */

export const SLOTS = 168;
/** Per-connector sample cap per slot before halving, so busy hours reflect roughly the last 8–16 weeks. */
const SEEN_CAP = 192;
/** Change log kept this long. */
const RETAIN_MIN = 400 * 24 * 60;
const SGT_OFFSET_MIN = 8 * 60;

export interface HistoryState {
  n: number;
  lastFeed: number;
  s: Int8Array;
  since: Uint32Array;
  lastStart: Uint32Array;
  lastEnd: Uint32Array;
}

export interface Slot {
  busy: Uint8Array;
  seen: Uint8Array;
}

/** Hour of the week in Singapore time: 0 = Monday 00:00–00:59, 167 = Sunday 23:00. */
export function slotOf(minutes: number): number {
  const local = minutes + SGT_OFFSET_MIN;
  const day = (Math.floor(local / 1440) + 3) % 7; // 1970-01-01 was a Thursday
  return day * 24 + Math.floor((local % 1440) / 60);
}

export function emptyState(): HistoryState {
  return { n: 0, lastFeed: 0, s: new Int8Array(0), since: new Uint32Array(0), lastStart: new Uint32Array(0), lastEnd: new Uint32Array(0) };
}

function grow<T extends Int8Array | Uint8Array | Uint32Array>(a: T, n: number, fill = 0): T {
  if (a.length >= n) return a;
  const b = new (a.constructor as new (n: number) => T)(n);
  if (fill) b.fill(fill);
  b.set(a);
  return b;
}

export function growState(st: HistoryState, n: number): HistoryState {
  if (n <= st.n) return st;
  return { n, lastFeed: st.lastFeed, s: grow(st.s, n, -1), since: grow(st.since, n), lastStart: grow(st.lastStart, n), lastEnd: grow(st.lastEnd, n) };
}

// Binary layout: uint32 [version, n, lastFeed], then s padded to 4 bytes, since, lastStart, lastEnd.
export function encodeState(st: HistoryState): Uint8Array {
  const pad = (st.n + 3) & ~3;
  const buf = new ArrayBuffer(12 + pad + st.n * 12);
  const head = new Uint32Array(buf, 0, 3);
  head.set([1, st.n, st.lastFeed]);
  new Int8Array(buf, 12, st.n).set(st.s.subarray(0, st.n));
  let o = 12 + pad;
  for (const a of [st.since, st.lastStart, st.lastEnd]) {
    new Uint32Array(buf, o, st.n).set(a.subarray(0, st.n));
    o += st.n * 4;
  }
  return new Uint8Array(buf);
}

export function decodeState(bytes: Uint8Array | null): HistoryState {
  if (!bytes || bytes.byteLength < 12) return emptyState();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const [version, n, lastFeed] = new Uint32Array(buf, 0, 3);
  const pad = (n + 3) & ~3;
  if (version !== 1 || buf.byteLength !== 12 + pad + n * 12) return emptyState();
  let o = 12 + pad;
  const next = () => {
    const a = new Uint32Array(buf.slice(o, o + n * 4));
    o += n * 4;
    return a;
  };
  return { n, lastFeed, s: new Int8Array(buf.slice(12, 12 + n)), since: next(), lastStart: next(), lastEnd: next() };
}

/**
 * Applies one snapshot to the state in place. `status[i]` belongs to connector
 * `index[i]`. Returns the changes as [index, state] pairs.
 */
export function applyStatus(st: HistoryState, index: Uint32Array, status: string, now: number): Array<[number, number]> {
  const changes: Array<[number, number]> = [];
  for (let i = 0; i < index.length; i++) {
    const ch = status[i];
    if (ch !== "0" && ch !== "1") continue;
    const k = index[i];
    const cur = ch === "1" ? 1 : 0;
    const prev = st.s[k];
    if (prev === cur) continue;
    if (prev === 0 && cur === 1) {
      // A session ended: it ran from `since` (if we saw it start) until now.
      st.lastStart[k] = st.since[k];
      st.lastEnd[k] = now;
    }
    // Only a change we saw happen has a known time; the first sighting doesn't.
    st.since[k] = prev === -1 ? 0 : now;
    st.s[k] = cur;
    changes.push([k, cur]);
  }
  st.lastFeed = now;
  return changes;
}

/** Adds one sample to an hour-of-week slot, halving a connector's counts once they reach the cap. */
export function accumulate(slot: Slot, index: Uint32Array, status: string): void {
  for (let i = 0; i < index.length; i++) {
    const ch = status[i];
    if (ch !== "0" && ch !== "1") continue;
    const k = index[i];
    if (slot.seen[k] >= SEEN_CAP) {
      slot.seen[k] >>= 1;
      slot.busy[k] >>= 1;
    }
    slot.seen[k]++;
    if (ch === "0") slot.busy[k]++;
  }
}

export function encodeChanges(changes: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(changes.length * 5);
  const dv = new DataView(out.buffer);
  changes.forEach(([k, s], i) => {
    dv.setUint32(i * 5, k, true);
    out[i * 5 + 4] = s;
  });
  return out;
}

/** D1 may hand a BLOB back as an ArrayBuffer, a typed array or a plain array of bytes. */
export function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  const b = toBytes(v);
  return b ? new TextDecoder().decode(b) : "";
}

// ── D1 ──────────────────────────────────────────────────────────────────

export type RecordResult = { recorded: false; reason: string } | { recorded: true; at: number; changes: number; connectors: number };

/** Records one LTA snapshot (connector ids + status string in the same order). Idempotent per snapshot time. */
export async function recordSnapshot(db: D1Database, ids: readonly string[], status: string, feedUpdated: string | null): Promise<RecordResult> {
  const t = feedUpdated ? Date.parse(feedUpdated) : NaN;
  if (!Number.isFinite(t)) return { recorded: false, reason: "snapshot has no time" };
  if (ids.length !== status.length) return { recorded: false, reason: "ids and status disagree" };
  const now = Math.round(t / 60_000);

  const rows = (await db.prepare("SELECT k, v FROM kv WHERE k IN ('ids', 'state')").all<{ k: string; v: unknown }>()).results;
  const known: string[] = JSON.parse(toText(rows.find((r) => r.k === "ids")?.v) || "[]");
  let st = decodeState(toBytes(rows.find((r) => r.k === "state")?.v));
  if (now <= st.lastFeed) return { recorded: false, reason: "already recorded" };

  const pos = new Map(known.map((id, i) => [id, i]));
  const index = new Uint32Array(ids.length);
  const added: string[] = [];
  ids.forEach((id, i) => {
    let k = pos.get(id);
    if (k === undefined) {
      k = known.length + added.length;
      pos.set(id, k);
      added.push(id);
    }
    index[i] = k;
  });
  const all = added.length ? [...known, ...added] : known;
  st = growState(st, all.length);
  const changes = applyStatus(st, index, status, now);

  const slotNo = slotOf(now);
  const slotRow = await db.prepare("SELECT busy, seen FROM slots WHERE slot = ?").bind(slotNo).first<{ busy: unknown; seen: unknown }>();
  const slot: Slot = {
    busy: grow(toBytes(slotRow?.busy) ?? new Uint8Array(0), all.length),
    seen: grow(toBytes(slotRow?.seen) ?? new Uint8Array(0), all.length),
  };
  accumulate(slot, index, status);

  const upsertKv = "INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated = excluded.updated";
  const batch = [
    db.prepare(upsertKv).bind("state", encodeState(st), now),
    db.prepare("INSERT INTO slots (slot, busy, seen) VALUES (?, ?, ?) ON CONFLICT (slot) DO UPDATE SET busy = excluded.busy, seen = excluded.seen").bind(slotNo, slot.busy, slot.seen),
    db.prepare("INSERT OR REPLACE INTO changes (ts, data) VALUES (?, ?)").bind(now, encodeChanges(changes)),
    db.prepare("DELETE FROM changes WHERE ts < ?").bind(now - RETAIN_MIN),
  ];
  if (added.length) batch.unshift(db.prepare(upsertKv).bind("ids", JSON.stringify(all), now));
  await db.batch(batch);
  return { recorded: true, at: now, changes: changes.length, connectors: all.length };
}

export interface ConnectorHistory {
  /** 1 free, 0 in use, null not seen yet. */
  s: 0 | 1 | null;
  /** When the current state began (epoch ms), if we saw it begin. */
  since: number | null;
  /** The last complete session we saw: start may be null if it began before we saw it. */
  last: { start: number | null; end: number } | null;
  /** % of samples in use for each hour of the week (0 = Monday 00:00 SGT); null where too few samples. */
  busy: Array<number | null>;
}

export interface HistoryResponse {
  /** Latest snapshot recorded (epoch ms), null before the first. */
  at: number | null;
  /** First snapshot recorded (epoch ms): how far back history goes. */
  from: number | null;
  connectors: Record<string, ConnectorHistory | null>;
}

// Per-isolate memo: state changes every 5 minutes, busy hours change slowly.
let readMemo: { at: number; pos: Map<string, number>; st: HistoryState; from: number | null } | null = null;
let slotMemo: { at: number; slots: Array<Slot | null> } | null = null;

export function __resetHistoryMemo(): void {
  readMemo = null;
  slotMemo = null;
}

export async function readHistory(db: D1Database, ids: readonly string[], nowMs = Date.now()): Promise<HistoryResponse> {
  if (!readMemo || nowMs - readMemo.at > 60_000) {
    const [kv, first] = await db.batch<{ k?: string; v?: unknown; ts?: number }>([
      db.prepare("SELECT k, v FROM kv WHERE k IN ('ids', 'state')"),
      db.prepare("SELECT MIN(ts) AS ts FROM changes"),
    ]);
    const rows = kv.results as Array<{ k: string; v: unknown }>;
    const known: string[] = JSON.parse(toText(rows.find((r) => r.k === "ids")?.v) || "[]");
    const ts = (first.results[0] as { ts?: number } | undefined)?.ts;
    readMemo = {
      at: nowMs,
      pos: new Map(known.map((id, i) => [id, i])),
      st: decodeState(toBytes(rows.find((r) => r.k === "state")?.v)),
      from: typeof ts === "number" ? ts * 60_000 : null,
    };
  }
  if (!slotMemo || nowMs - slotMemo.at > 60 * 60_000) {
    const res = await db.prepare("SELECT slot, busy, seen FROM slots").all<{ slot: number; busy: unknown; seen: unknown }>();
    const slots: Array<Slot | null> = Array.from({ length: SLOTS }, () => null);
    for (const r of res.results) {
      const busy = toBytes(r.busy);
      const seen = toBytes(r.seen);
      if (busy && seen && r.slot >= 0 && r.slot < SLOTS) slots[r.slot] = { busy, seen };
    }
    slotMemo = { at: nowMs, slots };
  }
  const { pos, st, from } = readMemo;
  const ms = (m: number) => (m ? m * 60_000 : null);
  const connectors: Record<string, ConnectorHistory | null> = {};
  for (const id of ids) {
    const k = pos.get(id);
    if (k === undefined || k >= st.n) {
      connectors[id] = null;
      continue;
    }
    const s = st.s[k];
    connectors[id] = {
      s: s === 1 ? 1 : s === 0 ? 0 : null,
      since: ms(st.since[k]),
      last: st.lastEnd[k] ? { start: ms(st.lastStart[k]), end: st.lastEnd[k] * 60_000 } : null,
      busy: slotMemo.slots.map((sl) => {
        const seen = sl && k < sl.seen.length ? sl.seen[k] : 0;
        return seen >= 3 ? Math.round((100 * sl!.busy[k]) / seen) : null;
      }),
    };
  }
  return { at: st.lastFeed ? st.lastFeed * 60_000 : null, from, connectors };
}
