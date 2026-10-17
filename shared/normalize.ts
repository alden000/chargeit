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
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Take the first number; for ranges like "7.4 / 22" use the highest, never glue digits together.
  const all = String(v).match(/\d+(?:\.\d+)?|\.\d+/g);
  if (!all) return null;
  const n = Math.max(...all.map(Number));
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
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
    const iso = `${m[1]}T${time}${m[3] ?? ""}${m[4] ?? "+08:00"}`;
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

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const firstConnector = (pl: Plug) => pl.connectors[0]?.id ?? "";
const plugKey = (pl: Plug) => `${firstConnector(pl)}|${pl.type}|${pl.current}|${pl.kw}|${pl.price}|${pl.priceType}`;
const pointKey = (pt: ChargePoint) => `${pt.plugs[0] ? plugKey(pt.plugs[0]) : ""}|${pt.operator}|${pt.position}|${pt.hours}`;

/**
 * LTA lists sites, charge points and connectors in a different order in every
 * snapshot. Sorting gives identical content identical bytes, which keeps the
 * stations file's version stable (see shared/split.ts).
 */
function canonicalPoints(points: ChargePoint[]): ChargePoint[] {
  for (const pt of points) {
    for (const pl of pt.plugs) pl.connectors.sort((a, b) => cmp(a.id, b.id));
    pt.plugs.sort((a, b) => cmp(plugKey(a), plugKey(b)));
  }
  return points.sort((a, b) => cmp(pointKey(a), pointKey(b)));
}

const lowestConnector = (points: ChargePoint[]) =>
  points.flatMap((pt) => pt.plugs.flatMap((pl) => pl.connectors.map((c) => c.id))).filter(Boolean).sort(cmp)[0] ?? "";

/** Turns the raw EVCBatch file into the compact payload. Never throws on odd records. */
export function normalizeBatch(raw: unknown, fetchedAt: Date = new Date()): ChargersPayload {
  const stations: Station[] = [];
  for (const st of findStations(raw)) {
    if (!isDict(st)) continue;
    const lat = num(pick(st, "latitude", "lat"));
    const lng = num(pick(st, "longtitude", "longitude", "lng", "lon"));
    if (lat === null || lng === null || !inSingapore(lat, lng)) continue;
    const points = canonicalPoints(
      list(pick(st, "chargingPoints"))
        .map(normalizePoint)
        .filter((p): p is ChargePoint => p !== null),
    );
    if (!points.length) continue;
    const name = str(pick(st, "name"));
    const postal = str(pick(st, "postalCode", "postal"));
    // Stable across feed refreshes so favourites and shared links survive.
    // Not location or name: LTA flips both for some sites between snapshots
    // (e.g. ~100 m apart, "IKEA FOOD CENTRE" ↔ "IKEA ALEXANDRA"). Postal codes
    // and charger IDs hold steady; finalised in assignIds().
    stations.push({
      id: str(pick(st, "locationId")) || postal,
      name: name || str(pick(st, "address")) || "EV charging point",
      address: str(pick(st, "address")),
      postal,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      points,
    });
  }
  assignIds(stations);
  stations.sort((a, b) => cmp(a.id, b.id));
  return {
    v: 1,
    feedUpdated: toIsoSgt(pick(raw, "LastUpdatedTime") ?? pick(pick(raw, "value"), "LastUpdatedTime")),
    fetchedAt: fetchedAt.toISOString(),
    stations,
  };
}

/**
 * Final ids: the postal code (or LTA locationId) on its own when unique; sites
 * sharing one are told apart by their lowest charger ID, then by order.
 */
function assignIds(stations: Station[]): void {
  const groups = new Map<string, Station[]>();
  for (const s of stations) {
    const base = s.id || `x${hashId(lowestConnector(s.points) || `${s.lat.toFixed(4)}|${s.lng.toFixed(4)}`)}`;
    s.id = base;
    groups.set(base, [...(groups.get(base) ?? []), s]);
  }
  const used = new Set<string>();
  for (const [base, group] of groups) {
    if (group.length === 1) {
      used.add(base);
      continue;
    }
    group.sort((a, b) => cmp(lowestConnector(a.points), lowestConnector(b.points)));
    for (const s of group) {
      let id = `${base}-${hashId(lowestConnector(s.points) || s.name)}`;
      for (let n = 1; used.has(id); n++) id = `${base}-${hashId(lowestConnector(s.points) || s.name)}-${n}`;
      used.add(id);
      s.id = id;
    }
  }
}
