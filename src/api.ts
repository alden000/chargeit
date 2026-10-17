import type { ChargersPayload } from "../shared/schema.ts";
import { applyStatus, type StationsPayload, type StatusPayload } from "../shared/split.ts";

/** Where the Cloudflare Worker lives. Set at build time via VITE_API_BASE. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") || "https://chargeit-proxy.1313277.xyz";

export type DataMode = "live" | "stale" | "offline" | "demo";

export interface LoadResult {
  payload: ChargersPayload;
  mode: DataMode;
}

const DATA_CACHE = "chargeit-data-v1";
const LAST_GOOD_URL = "/__chargeit/last-good.json"; // full payload (older versions / fallback path)
const STATIONS_URL = "/__chargeit/stations.json";
const STATUS_URL = "/__chargeit/status.json";
const TIMEOUT_MS = 15_000;

function isPayload(v: unknown): v is ChargersPayload {
  return !!v && typeof v === "object" && Array.isArray((v as ChargersPayload).stations);
}

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};

/**
 * Coerces every field to the type the UI expects. Data can come from the
 * network, Cache Storage or the bundled snapshot; whatever its origin, the
 * renderer only ever sees well-typed values.
 */
export function sanitizePayload(raw: ChargersPayload): ChargersPayload {
  const stations: ChargersPayload["stations"] = [];
  for (const st of raw.stations ?? []) {
    if (!st || typeof st !== "object") continue;
    const lat = n(st.lat);
    const lng = n(st.lng);
    if (lat === null || lng === null) continue;
    stations.push({
      id: s(st.id),
      name: s(st.name),
      address: s(st.address),
      postal: s(st.postal),
      lat,
      lng,
      points: (Array.isArray(st.points) ? st.points : []).map((pt) => ({
        operator: s(pt?.operator),
        position: s(pt?.position),
        hours: s(pt?.hours),
        plugs: (Array.isArray(pt?.plugs) ? pt.plugs : []).map((pl) => ({
          type: s(pl?.type),
          current: pl?.current === "AC" || pl?.current === "DC" ? pl.current : "",
          kw: n(pl?.kw),
          price: n(pl?.price),
          priceType: s(pl?.priceType),
          connectors: (Array.isArray(pl?.connectors) ? pl.connectors : []).map((c) => ({
            id: s(c?.id),
            s: c?.s === 1 || c?.s === 0 ? c.s : null,
          })),
        })),
      })),
    });
  }
  return { v: 1, feedUpdated: raw.feedUpdated ? s(raw.feedUpdated) : null, fetchedAt: s(raw.fetchedAt), stations };
}

async function fetchJson(url: string, timeout = TIMEOUT_MS, cache: RequestCache = "no-cache"): Promise<{ data: unknown; res: Response }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), res };
  } finally {
    clearTimeout(t);
  }
}

async function store(url: string, data: unknown): Promise<void> {
  try {
    if (!("caches" in self)) return;
    const c = await caches.open(DATA_CACHE);
    await c.put(url, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
  } catch {
    /* storage may be unavailable (private mode / quota) — the app still works online */
  }
}

async function stored(url: string): Promise<unknown> {
  try {
    if (!("caches" in self)) return null;
    const hit = await (await caches.open(DATA_CACHE)).match(url);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

const isStations = (v: unknown): v is StationsPayload => isPayload(v) && typeof (v as unknown as StationsPayload).sv === "string";
const isStatus = (v: unknown): v is StatusPayload => !!v && typeof v === "object" && typeof (v as StatusPayload).sv === "string" && typeof (v as StatusPayload).s === "string";

/** The big, rarely-changing part, kept in memory and on the device between refreshes. */
let stationsMem: StationsPayload | null = null;
async function localStations(): Promise<StationsPayload | null> {
  if (!stationsMem) {
    const s = await stored(STATIONS_URL);
    if (isStations(s)) stationsMem = s;
  }
  return stationsMem;
}

/** Thrown when the split endpoints are missing or disagree; the full endpoint is tried instead. */
class SplitUnavailable extends Error {}

/** Normal path: ~5 KB of availability, plus the stations file only when its version changes. */
async function loadSplit(): Promise<LoadResult> {
  const { data: status, res } = await fetchJson(`${API_BASE}/v1/status`).catch((err: Error) => {
    throw /^HTTP 4/.test(err.message) ? new SplitUnavailable(err.message) : err;
  });
  if (!isStatus(status)) throw new SplitUnavailable("Malformed status");
  let payload = await localStations().then((st) => st && applyStatus(st, status));
  if (!payload) {
    // Versioned URL, so the browser's HTTP cache may answer it too.
    const { data } = await fetchJson(`${API_BASE}/v1/stations?v=${encodeURIComponent(status.sv)}`, 30_000, "default");
    if (!isStations(data)) throw new SplitUnavailable("Malformed stations");
    payload = applyStatus(data, status);
    if (!payload) throw new SplitUnavailable("Stations changed mid-refresh");
    stationsMem = data;
    void store(STATIONS_URL, data);
  }
  void store(STATUS_URL, status);
  return { payload: sanitizePayload(payload), mode: res.headers.get("X-Stale") === "1" ? "stale" : "live" };
}

async function loadFull(): Promise<LoadResult> {
  const { data, res } = await fetchJson(`${API_BASE}/v1/chargers`);
  if (!isPayload(data)) throw new Error("Malformed payload");
  void store(LAST_GOOD_URL, data);
  return { payload: sanitizePayload(data), mode: res.headers.get("X-Stale") === "1" ? "stale" : "live" };
}

async function readLastGood(): Promise<ChargersPayload | null> {
  const [st, status] = await Promise.all([localStations(), stored(STATUS_URL)]);
  const split = st && isStatus(status) ? applyStatus(st, status) : null;
  const raw = await stored(LAST_GOOD_URL);
  const full = isPayload(raw) ? raw : null;
  if (split && full) return Date.parse(full.fetchedAt) > Date.parse(split.fetchedAt) ? full : split; // whichever is newer
  return split ?? full;
}

/** Live data from the Worker, falling back to the last good copy on this device. */
export async function loadChargers(): Promise<LoadResult> {
  try {
    try {
      return await loadSplit();
    } catch (err) {
      if (!(err instanceof SplitUnavailable)) throw err;
      return await loadFull();
    }
  } catch (err) {
    const last = await readLastGood();
    if (last) return { payload: sanitizePayload(last), mode: "offline" };
    throw err;
  }
}

/** A real LTA snapshot bundled with the app, for previews and when the API isn't reachable yet. */
export async function loadDemo(): Promise<LoadResult> {
  const { data } = await fetchJson(`${import.meta.env.BASE_URL}demo/chargers.json`, 30_000);
  if (!isPayload(data)) throw new Error("Malformed demo payload");
  return { payload: sanitizePayload(data), mode: "demo" };
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
