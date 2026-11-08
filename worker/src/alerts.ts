/**
 * Charger alerts. A phone registers a watch (its push subscription + which
 * connectors + "becomes free" or "is taken" + how long). Whenever a new LTA
 * snapshot is recorded, the connectors that changed are matched against the
 * watches and matching phones get a push, sent by PushSender Durable Objects
 * in batches so no single run exceeds the Workers Free subrequest limit.
 *
 * Nothing about the person is stored: only the push subscription, which the
 * browser creates for this site, and the watch itself. Watches expire.
 */
import { b64url, isPushEndpoint } from "./webpush";

const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
export const MAX_PER_PHONE = 10;
const MAX_TOTAL = 5000;
export const MIN_MINUTES = 15;
export const MAX_MINUTES = 12 * 60;
/** Alerts per PushSender run: under the 50-subrequest limit with room to spare. */
export const BATCH = 40;
const SENDERS = 20;

export interface WatchInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  station: string;
  name: string;
  connectors: string[];
  labels: Record<string, string>;
  event: 0 | 1;
  minutes: number;
  once: boolean;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

/** Validates a watch request; returns an error message instead when it isn't acceptable. */
export function parseWatch(body: unknown): WatchInput | string {
  if (!body || typeof body !== "object") return "body must be an object";
  const o = body as Record<string, unknown>;
  const sub = (o.subscription ?? {}) as Record<string, unknown>;
  const keys = (sub.keys ?? {}) as Record<string, unknown>;
  const endpoint = str(sub.endpoint, 1024);
  const p256dh = str(keys.p256dh, 200);
  const auth = str(keys.auth, 100);
  if (!endpoint || !isPushEndpoint(endpoint) || !p256dh || !auth) return "invalid push subscription";
  const station = str(o.station, 40);
  if (!station || !ID_RE.test(station)) return "invalid station";
  const name = (str(o.name, 200) ?? "").trim().slice(0, 80) || "a ChargeIt station";
  const connectors = Array.isArray(o.connectors) ? [...new Set(o.connectors.filter((c): c is string => typeof c === "string" && ID_RE.test(c)))] : [];
  if (!connectors.length || connectors.length > 200) return "invalid connectors";
  const labels: Record<string, string> = {};
  const rawLabels = o.labels && typeof o.labels === "object" ? (o.labels as Record<string, unknown>) : {};
  for (const c of connectors) {
    const l = str(rawLabels[c], 200);
    if (l) labels[c] = l.trim().slice(0, 24);
  }
  if (o.event !== 0 && o.event !== 1) return "invalid event";
  const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) ? Math.round(o.minutes) : NaN;
  if (!(minutes >= MIN_MINUTES && minutes <= MAX_MINUTES)) return "invalid duration";
  return { endpoint, p256dh, auth, station, name, connectors, labels, event: o.event, minutes, once: o.once !== false };
}

export async function addWatch(db: D1Database, w: WatchInput, nowMin: number): Promise<{ id: string; expires: number } | { error: string }> {
  const [perPhone, total] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM watches WHERE endpoint = ? AND expires > ?").bind(w.endpoint, nowMin),
    db.prepare("SELECT COUNT(*) AS n FROM watches WHERE expires > ?").bind(nowMin),
  ]);
  if ((perPhone.results[0]?.n ?? 0) >= MAX_PER_PHONE) return { error: `at most ${MAX_PER_PHONE} alerts at a time` };
  if ((total.results[0]?.n ?? 0) >= MAX_TOTAL) return { error: "alerts are full right now, try later" };
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const expires = nowMin + w.minutes;
  await db
    .prepare("INSERT INTO watches (id, endpoint, p256dh, auth, station, name, connectors, labels, event, once, expires, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, w.endpoint, w.p256dh, w.auth, w.station, w.name, JSON.stringify(w.connectors), JSON.stringify(w.labels), w.event, w.once ? 1 : 0, expires, nowMin)
    .run();
  return { id, expires };
}

export async function removeWatch(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM watches WHERE id = ?").bind(id).run();
}

/** Which of these watch ids are still active (not expired, not used up). */
export async function activeWatches(db: D1Database, ids: string[], nowMin: number): Promise<string[]> {
  if (!ids.length) return [];
  const res = await db
    .prepare(`SELECT id FROM watches WHERE expires > ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(nowMin, ...ids)
    .all<{ id: string }>();
  return res.results.map((r) => r.id);
}

export interface WatchRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  station: string;
  name: string;
  connectors: string;
  labels: string;
  event: number;
  once: number;
}

export interface Alert {
  id: string;
  once: boolean;
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: { title: string; body: string; tag: string; url: string };
}

/** Matches changed connectors (id → new state) against watches. */
export function matchAlerts(rows: WatchRow[], changed: ReadonlyMap<string, 0 | 1>): Alert[] {
  const out: Alert[] = [];
  for (const w of rows) {
    let connectors: string[];
    let labels: Record<string, string>;
    try {
      connectors = JSON.parse(w.connectors);
      labels = JSON.parse(w.labels);
    } catch {
      continue;
    }
    const hits = connectors.filter((c) => changed.get(c) === w.event);
    if (!hits.length) continue;
    const named = hits.map((c) => labels[c]).filter(Boolean);
    const what = w.event === 1 ? "free" : "taken";
    const who =
      named.length === hits.length && named.length <= 3
        ? `${named.join(", ")} ${hits.length > 1 ? "are" : "is"} ${what}`
        : `${hits.length} charger${hits.length > 1 ? "s" : ""} ${hits.length > 1 ? "are" : "is"} ${what}`;
    out.push({
      id: w.id,
      once: w.once === 1,
      endpoint: w.endpoint,
      p256dh: w.p256dh,
      auth: w.auth,
      payload: {
        title: w.event === 1 ? `Charger free · ${w.name}` : `Charger taken · ${w.name}`,
        body: `${who} now.`,
        tag: `chargeit-${w.id}`,
        url: `./#s=${encodeURIComponent(w.station)}`,
      },
    });
  }
  return out;
}

/**
 * After a snapshot is recorded: alert the phones watching any connector that
 * changed, prune expired watches, forget used-up and unreachable ones.
 */
export async function alertOnChanges(env: { HISTORY?: D1Database; SENDER?: DurableObjectNamespace }, changed: Array<[string, 0 | 1]>, nowMin: number): Promise<number> {
  const db = env.HISTORY;
  if (!db) return 0;
  await db.prepare("DELETE FROM watches WHERE expires <= ?").bind(nowMin).run();
  if (!changed.length || !env.SENDER) return 0;
  const rows = (await db.prepare("SELECT id, endpoint, p256dh, auth, station, name, connectors, labels, event, once FROM watches WHERE expires > ?").bind(nowMin).all<WatchRow>()).results;
  const alerts = matchAlerts(rows, new Map(changed));
  if (!alerts.length) return 0;
  const sender = env.SENDER;
  const batches: Alert[][] = [];
  for (let i = 0; i < alerts.length; i += BATCH) batches.push(alerts.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map(async (batch, i) => {
      try {
        const stub = sender.get(sender.idFromName(`sender-${i % SENDERS}`));
        const res = await stub.fetch("https://sender/send", { method: "POST", body: JSON.stringify(batch) });
        return (await res.json()) as { gone: string[] };
      } catch (err) {
        console.error("push batch failed:", String(err));
        return { gone: [] };
      }
    }),
  );
  const forget = [...new Set([...results.flatMap((r) => r.gone), ...alerts.filter((a) => a.once).map((a) => a.id)])];
  for (let i = 0; i < forget.length; i += 50) {
    const ids = forget.slice(i, i + 50);
    await db.prepare(`DELETE FROM watches WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
  }
  return alerts.length;
}
