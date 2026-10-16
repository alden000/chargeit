import type { ChargersPayload } from "../shared/schema.ts";

/** Where the Cloudflare Worker lives. Set at build time via VITE_API_BASE. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") || "https://chargeit-proxy.1313277.xyz";

export type DataMode = "live" | "stale" | "offline" | "demo";

export interface LoadResult {
  payload: ChargersPayload;
  mode: DataMode;
}

const DATA_CACHE = "chargeit-data-v1";
const LAST_GOOD_URL = "/__chargeit/last-good.json";
const TIMEOUT_MS = 15_000;

function isPayload(v: unknown): v is ChargersPayload {
  return !!v && typeof v === "object" && Array.isArray((v as ChargersPayload).stations);
}

async function fetchJson(url: string, timeout = TIMEOUT_MS): Promise<{ data: unknown; res: Response }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), res };
  } finally {
    clearTimeout(t);
  }
}

async function saveLastGood(payload: ChargersPayload): Promise<void> {
  try {
    if (!("caches" in self)) return;
    const c = await caches.open(DATA_CACHE);
    await c.put(LAST_GOOD_URL, new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
  } catch {
    /* storage may be unavailable (private mode / quota) — the app still works online */
  }
}

async function readLastGood(): Promise<ChargersPayload | null> {
  try {
    if (!("caches" in self)) return null;
    const c = await caches.open(DATA_CACHE);
    const hit = await c.match(LAST_GOOD_URL);
    if (!hit) return null;
    const data: unknown = await hit.json();
    return isPayload(data) ? data : null;
  } catch {
    return null;
  }
}

/** Live data from the Worker, falling back to the last good copy on this device. */
export async function loadChargers(): Promise<LoadResult> {
  try {
    const { data, res } = await fetchJson(`${API_BASE}/v1/chargers`);
    if (!isPayload(data)) throw new Error("Malformed payload");
    void saveLastGood(data);
    return { payload: data, mode: res.headers.get("X-Stale") === "1" ? "stale" : "live" };
  } catch (err) {
    const last = await readLastGood();
    if (last) return { payload: last, mode: "offline" };
    throw err;
  }
}

/** A real LTA snapshot bundled with the app, for previews and when the API isn't reachable yet. */
export async function loadDemo(): Promise<LoadResult> {
  const { data } = await fetchJson(`${import.meta.env.BASE_URL}demo/chargers.json`, 30_000);
  if (!isPayload(data)) throw new Error("Malformed demo payload");
  return { payload: data, mode: "demo" };
}

// ── OneMap place search (Singapore Land Authority, keyless, CORS *) ─────

export interface Place {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: Array<Record<string, string>> };
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const r of data.results ?? []) {
    const lat = parseFloat(r.LATITUDE);
    const lng = parseFloat(r.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = titleCase(r.SEARCHVAL || r.BUILDING || r.ADDRESS || "");
    const address = titleCase(r.ADDRESS || "") + (r.POSTAL && r.POSTAL !== "NIL" ? ` ${r.POSTAL}` : "");
    const key = `${name}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, address, lat, lng });
    if (out.length >= 5) break;
  }
  return out;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase()).replace(/\bMrt\b/g, "MRT").replace(/\bLrt\b/g, "LRT");
}
