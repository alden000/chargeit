/**
 * ChargeIt LTA proxy — Cloudflare Worker.
 *
 * Holds the LTA DataMall AccountKey as the secret `LTA_ACCOUNT_KEY` (the same
 * secret name the WhereIsTheBus proxy uses) so it never reaches the browser,
 * this repo or GitHub Actions.
 *
 *   GET /v1/chargers  → normalised snapshot of every EV charging point in SG
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

export interface Env {
  LTA_ACCOUNT_KEY: string;
  /** Optional comma-separated override of the CORS allow-list. */
  ALLOWED_ORIGINS?: string;
}

const LTA_BATCH_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch";
const FRESH_TTL = 60; // seconds an upstream pull is reused
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
const FRESH_KEY = "https://chargeit-cache.internal/v1/chargers/fresh";
const STALE_KEY = "https://chargeit-cache.internal/v1/chargers/last-good";

interface Snapshot {
  body: string;
  feedUpdated: string | null;
  fetchedAt: string;
  stale: boolean;
}

// Per-isolate memo and in-flight de-duplication: a burst of requests landing
// on one isolate costs exactly one upstream pull.
let memo: { snap: Snapshot; at: number } | null = null;
let inflight: Promise<Snapshot> | null = null;
let lastFailureAt = 0;

function allowedOrigins(env: Env): Set<string> {
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(extra.length ? extra : DEFAULT_ORIGINS);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Feed-Updated, X-Fetched-At, X-Stale",
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

function toSnapshot(payload: ChargersPayload): Snapshot {
  return { body: JSON.stringify(payload), feedUpdated: payload.feedUpdated, fetchedAt: payload.fetchedAt, stale: false };
}

async function readCache(key: string): Promise<Snapshot | null> {
  const hit = await caches.default.match(key);
  if (!hit) return null;
  return {
    body: await hit.text(),
    feedUpdated: hit.headers.get("X-Feed-Updated") || null,
    fetchedAt: hit.headers.get("X-Fetched-At") ?? "",
    stale: false,
  };
}

function writeCache(key: string, snap: Snapshot, ttl: number): Promise<void> {
  return caches.default.put(
    key,
    new Response(snap.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttl}`,
        "X-Feed-Updated": snap.feedUpdated ?? "",
        "X-Fetched-At": snap.fetchedAt,
      },
    }),
  );
}

async function getSnapshot(env: Env, ctx: ExecutionContext): Promise<Snapshot> {
  if (memo && Date.now() - memo.at < FRESH_TTL * 1000) return memo.snap;

  const fresh = await readCache(FRESH_KEY);
  if (fresh) {
    memo = { snap: fresh, at: Date.now() - ageMs(fresh) };
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
      const snap = toSnapshot(await pullFromLta(env));
      lastFailureAt = 0;
      memo = { snap, at: Date.now() };
      ctx.waitUntil(Promise.all([writeCache(FRESH_KEY, snap, FRESH_TTL), writeCache(STALE_KEY, snap, STALE_TTL)]));
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

function ageMs(snap: Snapshot): number {
  const t = Date.parse(snap.fetchedAt);
  return Number.isFinite(t) ? Math.max(0, Math.min(Date.now() - t, FRESH_TTL * 1000)) : 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(request, env, JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, HEAD, OPTIONS" });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/v1/chargers") {
      try {
        const snap = await getSnapshot(env, ctx);
        return json(request, env, snap.body, 200, {
          // Browsers/CDNs may reuse for a short while; the app polls every 60 s.
          "Cache-Control": snap.stale ? "no-store" : "public, max-age=30, stale-while-revalidate=30",
          "X-Feed-Updated": snap.feedUpdated ?? "",
          "X-Fetched-At": snap.fetchedAt,
          "X-Stale": snap.stale ? "1" : "0",
        });
      } catch (err) {
        console.error("chargers failed:", String(err));
        // Deliberately vague: never echo upstream details (or anything key-adjacent) to clients.
        return json(request, env, JSON.stringify({ error: "upstream_unavailable" }), 503, {
          "Cache-Control": "no-store",
          "Retry-After": "30",
        });
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
        }),
        200,
        { "Cache-Control": "no-store" },
      );
    }

    if (path === "/") {
      return json(request, env, JSON.stringify({ name: "chargeit-lta-proxy", endpoints: ["/v1/chargers", "/health"] }));
    }

    return json(request, env, JSON.stringify({ error: "not_found" }), 404);
  },
} satisfies ExportedHandler<Env>;

/** Test hook: clears per-isolate state. */
export function __resetForTests(): void {
  memo = null;
  inflight = null;
  lastFailureAt = 0;
}
