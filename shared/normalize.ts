import type { ChargePoint, ChargersPayload, Connector, ConnectorStatus, Plug, Station } from "./schema.ts";

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** Case-insensitive property lookup that skips null/empty values. */
function pick(obj: unknown, ...names: string[]): unknown {
  if (!isDict(obj)) return undefined;
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lower.set(k.toLowerCase(), v);
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseStatus(v: unknown): ConnectorStatus {
  const s = str(v);
  if (s === "1") return 1;
  if (s === "0") return 0;
  return null;
}

function parseCurrent(v: unknown, plugType: string): "AC" | "DC" | "" {
  const s = str(v).toUpperCase();
  if (s === "AC" || s === "DC") return s;
  // Fall back to what the plug implies when the feed omits `current`.
  if (/combo|ccs|chademo|gb\/?t/i.test(plugType)) return "DC";
  if (/type\s*[12]/i.test(plugType)) return "AC";
  return "";
}

/** Singapore's bounding box, generously padded. Rejects (0,0) and swapped coords. */
export function inSingapore(lat: number, lng: number): boolean {
  return lat > 1.1 && lat < 1.5 && lng > 103.55 && lng < 104.15;
}

/** Small, stable, URL-safe hash (FNV-1a → base36). */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Converts LTA's "YYYY-MM-DD HH:mm:ss" (Singapore time, no zone) to ISO. */
export function toIsoSgt(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(.*)$/);
  if (m) {
    const zone = m[3].trim();
    const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
    const iso = `${m[1]}T${time}${zone ? zone : "+08:00"}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Finds the station array wherever LTA put it (`evLocationsData` today). */
export function findStations(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const walk = (o: unknown, depth: number): unknown[] | null => {
    if (depth > 6 || o === null || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length && isDict(o[0]) && pick(o[0], "chargingPoints") !== undefined) return o;
      for (const v of o) {
        const r = walk(v, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const direct = pick(o, "evLocationsData");
    if (Array.isArray(direct)) return direct;
    for (const v of Object.values(o as Dict)) {
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(root, 0) ?? [];
}

function normalizePlug(raw: unknown, inheritedIds: unknown): Plug | null {
  if (!isDict(raw)) return null;
  const type = str(pick(raw, "plugType", "type"));
  // Batch feed nests evIds inside plugTypes; the per-postal-code API puts them on the charge point.
  const idsRaw = pick(raw, "evIds") ?? inheritedIds;
  const seen = new Set<string>();
  const connectors: Connector[] = [];
  for (const ev of list(idsRaw)) {
    if (!isDict(ev)) continue;
    const id = str(pick(ev, "evCpId", "id"));
    const key = id || `#${connectors.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    connectors.push({ id, s: parseStatus(pick(ev, "status")) });
  }
  const priceType = str(pick(raw, "priceType"));
  let price = num(pick(raw, "price"));
  if (/free/i.test(priceType)) price = 0;
  return {
    type: type || "Unknown",
    current: parseCurrent(pick(raw, "current"), type),
    kw: num(pick(raw, "powerRating", "chargingSpeed")),
    price,
    priceType: /free/i.test(priceType) ? "free" : priceType,
    connectors,
  };
}

function normalizePoint(raw: unknown): ChargePoint | null {
  if (!isDict(raw)) return null;
  const inheritedIds = pick(raw, "evIds");
  const plugs = list(pick(raw, "plugTypes"))
    .map((p) => normalizePlug(p, inheritedIds))
    .filter((p): p is Plug => p !== null);
  if (!plugs.length) return null;
  return {
    operator: str(pick(raw, "operator")),
    position: str(pick(raw, "position")),
    hours: str(pick(raw, "operatingHours", "operationHours")),
    plugs,
  };
}

/** Turns the raw EVCBatch file into the compact payload. Never throws on odd records. */
export function normalizeBatch(raw: unknown, fetchedAt: Date = new Date()): ChargersPayload {
  const stations: Station[] = [];
  const ids = new Map<string, number>();
  for (const st of findStations(raw)) {
    if (!isDict(st)) continue;
    const lat = num(pick(st, "latitude", "lat"));
    const lng = num(pick(st, "longtitude", "longitude", "lng", "lon"));
    if (lat === null || lng === null || !inSingapore(lat, lng)) continue;
    const points = list(pick(st, "chargingPoints"))
      .map(normalizePoint)
      .filter((p): p is ChargePoint => p !== null);
    if (!points.length) continue;
    const name = str(pick(st, "name"));
    const postal = str(pick(st, "postalCode", "postal"));
    let id = str(pick(st, "locationId")) || `${postal || "x"}-${hashId(`${name}|${lat.toFixed(5)}|${lng.toFixed(5)}`)}`;
    const n = ids.get(id) ?? 0;
    ids.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    stations.push({
      id,
      name: name || str(pick(st, "address")) || "EV charging point",
      address: str(pick(st, "address")),
      postal,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      points,
    });
  }
  return {
    v: 1,
    feedUpdated: toIsoSgt(pick(raw, "LastUpdatedTime") ?? pick(pick(raw, "value"), "LastUpdatedTime")),
    fetchedAt: fetchedAt.toISOString(),
    stations,
  };
}
