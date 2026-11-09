/**
 * ChargeIt LTA proxy — Cloudflare Worker.
 *
 * Holds the LTA DataMall AccountKey as the secret `LTA_ACCOUNT_KEY` (the same
 * secret name the WhereIsTheBus proxy uses) so it never reaches the browser,
 * this repo or GitHub Actions.
 *
 *   GET /v1/status    → availability only, ~5 KB gzipped (the app polls this)
 *   GET /v1/stations  → everything else, versioned by `sv` (see shared/split.ts)
 *   GET /v1/chargers  → the full combined snapshot (older app versions)
 *   GET /v1/history?c=<connector ids> → per-charger state history and busy hours
 *
 * Every LTA snapshot is recorded in the D1 database bound as HISTORY (see
 * history.ts): by the HistoryClock Durable Object, whose alarm fires a minute
 * after each 5-minute snapshot (Workers Free allows only 5 cron triggers per
 * account), and opportunistically whenever a request pulls a fresh snapshot.
 *   GET /health       → { ok, feedUpdated, fetchedAt, stale }
 *
 * EVCBatch is a two-step API: the DataMall call returns a short-lived signed
 * S3 link, and that link serves the actual file. LTA refreshes it every ~5
 * minutes, so one upstream pull per FRESH_TTL per colo is plenty no matter how
 * many people have the app open. A longer-lived "last good" copy lets the app
 * keep working while LTA is having a bad day.
 */
import { normalizeBatch } from "../../shared/normalize";
import type { ChargersPayload } from "../../shared/schema";
import { nextFeedAt } from "../../shared/cadence";
import { connectorIds, layoutKey, statusString, stripStatusJson } from "../../shared/split";
import { readHistory, recordSnapshot, type RecordResult } from "./history";
import { activeWatches, addWatch, alertOnChanges, parseWatch, removeWatch, type Alert } from "./alerts";
import { loadVapid, sendPush, type Vapid } from "./webpush";

export interface Env {
  LTA_ACCOUNT_KEY: string;
  /** Charger history database; history endpoints and recording are off without it. */
  HISTORY?: D1Database;
  /** The HistoryClock Durable Object that records every snapshot on a timer. */
  CLOCK?: DurableObjectNamespace;
  /** PushSender Durable Objects: each sends one batch of alert pushes. */
  SENDER?: DurableObjectNamespace;
  /** VAPID key pair for Web Push (P-256 private JWK). Secret, set by setup-push-keys.yml. */
  VAPID_JWK?: string;
  /** Owner's passphrase (secret, set in the Cloudflare dashboard). Unlocks alerts without an end time. */
  OWNER_KEY?: string;
  /** Optional comma-separated override of the CORS allow-list. */
  ALLOWED_ORIGINS?: string;
}

const LTA_BATCH_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch";
const FRESH_TTL = 60; // max seconds an upstream pull is reused
const MIN_FRESH_TTL = 15; // floor, so a late LTA publish is re-checked without hammering
const STALE_TTL = 24 * 60 * 60; // seconds a last-good copy may be served if LTA fails
// One overall budget for the whole two-step pull, bodies included. It must stay
// well under the app's own 15 s timeout so the last-good fallback reaches
// clients before they give up.
const UPSTREAM_DEADLINE_MS = 8_000;
// After a failed pull, don't hit LTA again for this long (protects the key's quota).
const RETRY_BACKOFF_MS = 20_000;

const DEFAULT_ORIGINS = ["https://chargeit.wwweeeiii.com", "https://alden000.github.io", "http://localhost:5173", "http://localhost:4173"];

// Fixed cache keys: the cached body carries no CORS headers, they're added per
// request on the way out — so one origin can never poison another's entry.
// Each tier holds the three bodies of one snapshot under /full, /stations, /status.
const FRESH_KEY = "https://chargeit-cache.internal/v1/chargers/fresh";
const STALE_KEY = "https://chargeit-cache.internal/v1/chargers/last-good";
const PARTS = ["full", "stations", "status", "ids"] as const;

interface Snapshot {
  /** Full combined payload (/v1/chargers). */
  body: string;
  /** Availability-free stations payload (/v1/stations). */
  stations: string;
  /** Availability only (/v1/status). */
  status: string;
  /** JSON array of connector ids in the status string's order (for history). */
  ids: string;
  /** Layout and content versions of `stations` (see shared/split.ts). */
  sv: string;
  cv: string;
  feedUpdated: string | null;
  fetchedAt: string;
  stale: boolean;
}

// Per-isolate memo and in-flight de-duplication: a burst of requests landing
// on one isolate costs exactly one upstream pull.
let memo: { snap: Snapshot; until: number } | null = null;
let inflight: Promise<Snapshot> | null = null;
let lastFailureAt = 0;

function allowedOrigins(env: Env): Set<string> {
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(extra.length ? extra : DEFAULT_ORIGINS);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Owner-Key",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Feed-Updated, X-Fetched-At, X-Stale, X-SV",
    Vary: "Origin",
  };
  if (origin && allowedOrigins(env).has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(request: Request, env: Env, body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

function findLink(obj: unknown): string | null {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const l = findLink(v);
      if (l) return l;
    }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === "link" && typeof v === "string" && v.startsWith("https://")) return v;
    }
    for (const v of Object.values(obj)) {
      const l = findLink(v);
      if (l) return l;
    }
  }
  return null;
}

/** Reads a body that may be plain JSON or a gzip file served without Content-Encoding. */
async function readJson(res: Response): Promise<unknown> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function pullFromLta(env: Env): Promise<ChargersPayload> {
  if (!env.LTA_ACCOUNT_KEY) throw new Error("LTA_ACCOUNT_KEY secret is not configured");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("upstream deadline exceeded")), UPSTREAM_DEADLINE_MS);
  const deadline = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }));
  // Race every step (including body reads) against the deadline.
  const step = <T>(p: Promise<T>) => Promise.race([p, deadline]);
  try {
    const meta = await step(fetch(LTA_BATCH_URL, { headers: { AccountKey: env.LTA_ACCOUNT_KEY, accept: "application/json" }, signal: ctl.signal }));
    if (!meta.ok) throw new Error(`EVCBatch responded ${meta.status}`);
    const link = findLink(await step(meta.json()));
    if (!link) throw new Error("EVCBatch response had no download Link");
    const file = await step(fetch(link, { signal: ctl.signal }));
    if (!file.ok) throw new Error(`EVCBatch file responded ${file.status}`);
    const payload = normalizeBatch(await step(readJson(file)));
    if (!payload.stations.length) throw new Error("EVCBatch file contained no stations");
    return payload;
  } finally {
    clearTimeout(timer);
    deadline.catch(() => undefined);
  }
}

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function toSnapshot(payload: ChargersPayload): Promise<Snapshot> {
  // One serialisation of the big array; everything else is derived from strings.
  const stationsJson = JSON.stringify(payload.stations);
  const stripped = stripStatusJson(stationsJson);
  const [sv, cv] = await Promise.all([shortHash(layoutKey(payload.stations)), shortHash(stripped)]);
  const head = `"v":1,"feedUpdated":${JSON.stringify(payload.feedUpdated)},"fetchedAt":${JSON.stringify(payload.fetchedAt)}`;
  return {
    body: `{${head},"stations":${stationsJson}}`,
    stations: `{"v":1,"sv":"${sv}","cv":"${cv}","stations":${stripped}}`,
    status: `{${head},"sv":"${sv}","cv":"${cv}","s":"${statusString(payload.stations)}"}`,
    ids: JSON.stringify(connectorIds(payload.stations)),
    sv,
    cv,
    feedUpdated: payload.feedUpdated,
    fetchedAt: payload.fetchedAt,
    stale: false,
  };
}

async function readCache(key: string): Promise<Snapshot | null> {
  const hits = await Promise.all(PARTS.map((p) => caches.default.match(`${key}/${p}`)));
  if (hits.some((h) => !h)) return null; // all parts or nothing
  const [full, stations, status, ids] = await Promise.all(hits.map((h) => h!.text()));
  const h = hits[0]!.headers;
  if (!h.get("X-SV") || !h.get("X-CV")) return null; // also drops entries from before cv existed
  return {
    body: full,
    stations,
    status,
    ids,
    sv: h.get("X-SV")!,
    cv: h.get("X-CV")!,
    feedUpdated: h.get("X-Feed-Updated") || null,
    fetchedAt: h.get("X-Fetched-At") ?? "",
    stale: false,
  };
}

async function writeCache(key: string, snap: Snapshot, ttl: number): Promise<void> {
  const bodies = { full: snap.body, stations: snap.stations, status: snap.status, ids: snap.ids };
  await Promise.all(
    PARTS.map((p) =>
      caches.default.put(
        `${key}/${p}`,
        new Response(bodies[p], {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${ttl}`,
            "X-Feed-Updated": snap.feedUpdated ?? "",
            "X-Fetched-At": snap.fetchedAt,
            "X-SV": snap.sv,
            "X-CV": snap.cv,
          },
        }),
      ),
    ),
  );
}

/**
 * Reuse a pull until LTA's next snapshot should be out (at most FRESH_TTL), so
 * the first request after a new 5-minute snapshot fetches it rather than
 * getting up to a minute of the previous one.
 */
export function freshTtlSeconds(feedUpdated: string | null, fetchedAtMs: number): number {
  const until = nextFeedAt(feedUpdated, fetchedAtMs);
  return Math.max(MIN_FRESH_TTL, Math.min(FRESH_TTL, Math.ceil((until - fetchedAtMs) / 1000)));
}

function freshUntil(snap: Snapshot): number {
  const t = Date.parse(snap.fetchedAt);
  const at = Number.isFinite(t) ? Math.min(t, Date.now()) : Date.now();
  return at + freshTtlSeconds(snap.feedUpdated, at) * 1000;
}

async function getSnapshot(env: Env, ctx: ExecutionContext): Promise<Snapshot> {
  if (memo && Date.now() < memo.until) return memo.snap;

  const fresh = await readCache(FRESH_KEY);
  if (fresh) {
    memo = { snap: fresh, until: freshUntil(fresh) };
    return fresh;
  }

  // Recently failed: don't hammer LTA, go straight to the last good copy.
  if (Date.now() - lastFailureAt < RETRY_BACKOFF_MS) {
    const last = memo?.snap ?? (await readCache(STALE_KEY));
    if (last) return { ...last, stale: true };
    throw new Error("upstream recently failed; backing off");
  }

  inflight ??= (async () => {
    try {
      const snap = await toSnapshot(await pullFromLta(env));
      lastFailureAt = 0;
      memo = { snap, until: freshUntil(snap) };
      const ttl = freshTtlSeconds(snap.feedUpdated, Date.now());
      ctx.waitUntil(Promise.all([writeCache(FRESH_KEY, snap, ttl), writeCache(STALE_KEY, snap, STALE_TTL)]));
      if (env.HISTORY) ctx.waitUntil(recordFresh(env, env.HISTORY, snap).catch((e) => console.error("history record failed:", String(e))));
      return snap;
    } catch (err) {
      lastFailureAt = Date.now();
      const last = memo?.snap ?? (await readCache(STALE_KEY));
      if (last) {
        console.warn("LTA pull failed, serving last good copy:", String(err));
        return { ...last, stale: true };
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    startClock(env, ctx);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const writable = path === "/v1/watch" && (request.method === "POST" || request.method === "DELETE");
    if (request.method !== "GET" && request.method !== "HEAD" && !writable) {
      return json(request, env, JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, HEAD, OPTIONS" });
    }

    if (path === "/v1/owner") {
      // Lets the app confirm an owner key before saving it. Slowed down a little to blunt guessing.
      const owner = await isOwner(request, env);
      if (!owner) await new Promise((r) => setTimeout(r, 400));
      return json(request, env, JSON.stringify({ owner }), 200, { "Cache-Control": "no-store" });
    }

    if (path === "/v1/push/key") {
      const vapid = await getVapid(env).catch(() => null);
      if (!vapid) return json(request, env, JSON.stringify({ error: "push_unavailable" }), 503, { "Cache-Control": "no-store" });
      return json(request, env, JSON.stringify({ key: vapid.publicKey }), 200, { "Cache-Control": "public, max-age=3600" });
    }

    if (path === "/v1/watch") {
      if (!env.HISTORY) return json(request, env, JSON.stringify({ error: "alerts_unavailable" }), 503, { "Cache-Control": "no-store" });
      const nowMin = Math.round(Date.now() / 60_000);
      const noStore = { "Cache-Control": "no-store" };
      try {
        if (request.method === "POST") {
          const text = await request.text();
          if (text.length > 16_384) return json(request, env, JSON.stringify({ error: "too_large" }), 413, noStore);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return json(request, env, JSON.stringify({ error: "invalid JSON" }), 400, noStore);
          }
          const owner = await isOwner(request, env);
          const w = parseWatch(body, { owner });
          if (typeof w === "string") return json(request, env, JSON.stringify({ error: w }), 400, noStore);
          const out = await addWatch(env.HISTORY, w, nowMin, { owner });
          if ("error" in out) return json(request, env, JSON.stringify(out), 429, noStore);
          return json(request, env, JSON.stringify({ id: out.id, expires: out.expires * 60_000 }), 201, noStore);
        }
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id") ?? "";
          if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) return json(request, env, JSON.stringify({ error: "bad_request" }), 400, noStore);
          await removeWatch(env.HISTORY, id);
          return json(request, env, JSON.stringify({ ok: true }), 200, noStore);
        }
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => /^[A-Za-z0-9_-]{16,40}$/.test(id)).slice(0, 50);
        return json(request, env, JSON.stringify({ active: await activeWatches(env.HISTORY, ids, nowMin) }), 200, noStore);
      } catch (err) {
        console.error("watch failed:", String(err));
        return json(request, env, JSON.stringify({ error: "alerts_unavailable" }), 503, noStore);
      }
    }

    if (path === "/v1/chargers" || path === "/v1/status" || path === "/v1/stations") {
      try {
        const snap = await getSnapshot(env, ctx);
        const meta = { "X-Feed-Updated": snap.feedUpdated ?? "", "X-Fetched-At": snap.fetchedAt, "X-Stale": snap.stale ? "1" : "0", "X-SV": snap.sv };
        if (path === "/v1/stations") {
          // Requested by content version (?v=<cv>): that exact content never changes.
          const pinned = url.searchParams.get("v") === snap.cv;
          return json(request, env, snap.stations, 200, { ...meta, "Cache-Control": pinned ? "public, max-age=604800, immutable" : "public, max-age=60" });
        }
        // Short: the app times its requests to LTA's 5-minute snapshots.
        return json(request, env, path === "/v1/status" ? snap.status : snap.body, 200, { ...meta, "Cache-Control": snap.stale ? "no-store" : "public, max-age=15" });
      } catch (err) {
        console.error("chargers failed:", String(err));
        // Deliberately vague: never echo upstream details (or anything key-adjacent) to clients.
        return json(request, env, JSON.stringify({ error: "upstream_unavailable" }), 503, {
          "Cache-Control": "no-store",
          "Retry-After": "30",
        });
      }
    }

    if (path === "/v1/history") {
      if (!env.HISTORY) return json(request, env, JSON.stringify({ error: "history_unavailable" }), 503, { "Cache-Control": "no-store" });
      const ids = (url.searchParams.get("c") ?? "").split(",").filter(Boolean);
      if (!ids.length || ids.length > 200 || ids.some((id) => !/^[A-Za-z0-9._-]{1,40}$/.test(id))) {
        return json(request, env, JSON.stringify({ error: "bad_request" }), 400, { "Cache-Control": "no-store" });
      }
      try {
        return json(request, env, JSON.stringify(await readHistory(env.HISTORY, ids)), 200, { "Cache-Control": "public, max-age=60" });
      } catch (err) {
        console.error("history read failed:", String(err));
        return json(request, env, JSON.stringify({ error: "history_unavailable" }), 503, { "Cache-Control": "no-store" });
      }
    }

    if (path === "/health") {
      const snap = memo?.snap ?? (await readCache(FRESH_KEY)) ?? (await readCache(STALE_KEY));
      return json(
        request,
        env,
        JSON.stringify({
          ok: true,
          keyConfigured: Boolean(env.LTA_ACCOUNT_KEY),
          feedUpdated: snap?.feedUpdated ?? null,
          fetchedAt: snap?.fetchedAt ?? null,
          stale: snap ? Date.now() - Date.parse(snap.fetchedAt) > FRESH_TTL * 1000 * 2 : null,
          history: lastRecord,
        }),
        200,
        { "Cache-Control": "no-store" },
      );
    }

    if (path === "/") {
      return json(request, env, JSON.stringify({ name: "chargeit-lta-proxy", endpoints: ["/v1/status", "/v1/stations", "/v1/chargers", "/v1/history", "/v1/watch", "/v1/push/key", "/v1/owner", "/health"] }));
    }

    return json(request, env, JSON.stringify({ error: "not_found" }), 404);
  },

} satisfies ExportedHandler<Env>;

/** Outcome of the last recording attempt in this isolate, for /health. */
let lastRecord: Record<string, unknown> | null = null;

async function recordFresh(env: Env, db: D1Database, snap: Snapshot): Promise<RecordResult> {
  const status = (JSON.parse(snap.status) as { s: string }).s;
  const result = await recordSnapshot(db, JSON.parse(snap.ids) as string[], status, snap.feedUpdated);
  await afterRecord(env, result);
  return result;
}

/** Whoever records a snapshot first (timer or request) sends its alerts; the other finds it already recorded. */
async function afterRecord(env: Env, result: RecordResult): Promise<void> {
  const tried = new Date().toISOString();
  if (!result.recorded) {
    lastRecord = { ...result, tried };
    return;
  }
  const { changed, ...summary } = result;
  const alerts = await alertOnChanges(env, changed, result.at).catch((err) => {
    console.error("alerts failed:", String(err));
    return -1;
  });
  lastRecord = { ...summary, changed: changed.length, alerts, tried };
}

/** Constant-time check of the X-Owner-Key header against the OWNER_KEY secret. */
async function isOwner(request: Request, env: Env): Promise<boolean> {
  const given = request.headers.get("X-Owner-Key");
  if (!env.OWNER_KEY || env.OWNER_KEY.length < 12 || !given) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(env.OWNER_KEY)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const PUSH_SUBJECT = "https://chargeit.wwweeeiii.com";
let vapidMemo: Promise<Vapid> | null = null;
function getVapid(env: Env): Promise<Vapid> {
  if (!env.VAPID_JWK) return Promise.reject(new Error("VAPID_JWK not configured"));
  vapidMemo ??= loadVapid(env.VAPID_JWK, PUSH_SUBJECT).catch((err) => {
    vapidMemo = null;
    throw err;
  });
  return vapidMemo;
}

/**
 * Sends one batch of alert pushes (at most ~40, under the 50-subrequest limit
 * of a single run). Returns the watch ids whose subscriptions are gone.
 */
export class PushSender {
  constructor(
    _state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const alerts = (await request.json()) as Alert[];
    const vapid = await getVapid(this.env);
    const gone: string[] = [];
    let sent = 0;
    for (const a of alerts.slice(0, 45)) {
      const r = await sendPush(vapid, a, a.payload, { ttl: 900, topic: a.id });
      if (r === "gone") gone.push(a.id);
      else if (r === "sent") sent++;
    }
    return Response.json({ gone, sent });
  }
}

let clockStarted = false;
/** Makes sure the HistoryClock alarm is running (once per isolate; arming it is idempotent). */
function startClock(env: Env, ctx: ExecutionContext): void {
  if (!env.CLOCK || !env.HISTORY || clockStarted) return;
  clockStarted = true;
  const stub = env.CLOCK.get(env.CLOCK.idFromName("history"));
  ctx.waitUntil(
    stub.fetch("https://clock/start").then(
      (r) => void r.body?.cancel(),
      () => (clockStarted = false),
    ),
  );
}

/** Next run: a minute after the next 5-minute LTA snapshot. */
export function nextClockRun(now: number): number {
  const PERIOD = 5 * 60_000;
  const OFFSET = 60_000;
  return Math.floor((now - OFFSET) / PERIOD) * PERIOD + PERIOD + OFFSET;
}

/**
 * A single Durable Object whose alarm records every LTA snapshot, standing in
 * for a cron trigger. Pulls straight from LTA (no shared cache in here): one
 * small DataMall call per 5 minutes.
 */
export class HistoryClock {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(): Promise<Response> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(nextClockRun(Date.now()));
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next = nextClockRun(now);
    try {
      if (this.env.HISTORY) {
        const payload = await pullFromLta(this.env);
        const result = await recordSnapshot(this.env.HISTORY, connectorIds(payload.stations), statusString(payload.stations), payload.feedUpdated);
        await afterRecord(this.env, result);
        // LTA running late (still the previous snapshot): look again in a minute, up to 3 minutes past the mark.
        const mark = now - (now % 300_000);
        const late = !payload.feedUpdated || Date.parse(payload.feedUpdated) < mark;
        if (!result.recorded && late && now - mark < 180_000) next = now + 60_000;
      }
    } catch (err) {
      console.error("history clock failed:", String(err));
      if ((now % 300_000) < 180_000) next = now + 60_000;
    } finally {
      await this.state.storage.setAlarm(next);
    }
  }
}

/** Test hook: clears per-isolate state. */
export function __resetForTests(): void {
  memo = null;
  inflight = null;
  lastFailureAt = 0;
  lastRecord = null;
}
