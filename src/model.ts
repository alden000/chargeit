import type { ChargersPayload, Plug, Station } from "../shared/schema.ts";
import { PROVIDER_LOGOS } from "./providers.generated.ts";

export type Availability = "free" | "few" | "busy" | "offline";
export type SpeedTier = 0 | 1 | 2 | 3;

export interface Summary {
  free: number;
  busy: number;
  offline: number;
  total: number;
  /** free / (free + busy); 0 when nothing is usable. */
  ratio: number;
  state: Availability;
  maxKw: number | null;
  tier: SpeedTier;
  hasDC: boolean;
  plugTypes: string[];
  operators: string[];
  /** Cheapest published per-kWh price (0 = free), or null if none listed. */
  minPrice: number | null;
}

export interface StationVM extends Station {
  sum: Summary;
  /** Lower-cased haystack for search. */
  hay: string;
}

export interface Operator {
  key: string;
  name: string;
  short: string;
  color: string;
  /** Slug of a bundled logo in public/providers/<slug>.png, when we have a vetted one. */
  logo: string | null;
}

// Registered company names → the names drivers actually recognise.
// [matcher, display name, monogram, monogram colour, logo slug]
const OPERATORS: Array<[RegExp, string, string, string, string]> = [
  [/^sp\b|sp mobility/i, "SP Mobility", "SP", "#0B6FD6", "sp"],
  [/charge\s*\+|chargeplus/i, "Charge+", "C+", "#00A86B", "chargeplus"],
  [/comfortdelgro|cdg/i, "CDG ENGIE", "CD", "#1C5FB8", "cdg-engie"],
  [/shell/i, "Shell Recharge", "SH", "#D9A400", "shell"],
  [/strides/i, "Strides YTL", "ST", "#E0592A", "strides"],
  [/^volt\b|volt singapore/i, "Volt", "VO", "#7A4DFF", "volt"],
  [/tesla/i, "Tesla", "TE", "#CC0000", "tesla"],
  [/mnl/i, "MNL Solutions", "MN", "#4F7CAC", "mnl"],
  [/great\s*charge/i, "Great Charge", "GC", "#2E9E8F", "greatcharge"],
  [/fastparkncharge|fast\s*park/i, "FastParkNCharge", "FP", "#E3365B", "fastparkncharge"],
  [/ev\s*mobility/i, "EV Mobility", "EM", "#3A8F3A", "evmobility"],
  [/\bked\b/i, "KED Energy", "KE", "#8C5A2B", "ked"],
  [/novowatt/i, "Novowatt", "NW", "#5B48C9", "novowatt"],
  [/eigen/i, "Eigen Energy", "EE", "#127C9E", "eigen"],
  [/st\s*engineering/i, "ST Engineering", "ST", "#D2232A", "stengineering"],
  [/solateks/i, "Solateks", "SO", "#2F7D4A", "solateks"],
  [/city\s*energy/i, "City Energy GO", "CE", "#E87722", "cityenergy"],
  [/evone/i, "EVOne", "E1", "#0E7C86", "evone"],
  [/\bup\s*solutions/i, "UP Solutions", "UP", "#3355AA", "upsolutions"],
  [/airetec/i, "Airetec", "AT", "#1F6FB2", "airetec"],
  [/buswa?ys/i, "Busways", "BW", "#C8102E", "busways"],
  [/wes\s*cares/i, "WES Cares Energy", "WE", "#2B8A3E", "wescares"],
  [/union\s*gas/i, "Union Gas", "UG", "#D52B1E", "uniongas"],
  [/\bg\.?\s*tech\b/i, "G. Tech", "GT", "#4A5568", "gtech"],
  [/eneready/i, "EneReady", "ER", "#0091D5", "eneready"],
  [/^electric\b/i, "Electric", "EL", "#5B48C9", "electric"],
  [/iwow/i, "IWOW", "IW", "#00A0E9", "iwow"],
  [/p-?parking/i, "P-Parking", "PP", "#E30613", "pparking"],
  [/alpina/i, "Alpina Energy", "AL", "#1E7FCB", "alpina"],
  [/bluesg|blue\s*sg/i, "BlueSG", "BS", "#0072CE", "bluesg"],
  [/sunseap|edp/i, "EDP Renewables", "ED", "#E1251B", "edp"],
  [/keppel/i, "Keppel", "KP", "#C8102E", "keppel"],
  [/\btotal\s*energies\b/i, "TotalEnergies", "TT", "#ED0000", "totalenergies"],
  [/\bbp\b/i, "bp pulse", "BP", "#009B3A", "bp"],
];

const opCache = new Map<string, Operator>();

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function operatorInfo(raw: string): Operator {
  const key = raw.trim();
  const hit = opCache.get(key);
  if (hit) return hit;
  let op: Operator;
  const known = OPERATORS.find(([re]) => re.test(key));
  if (known) {
    op = { key, name: known[1], short: known[2], color: known[3], logo: PROVIDER_LOGOS.has(known[4]) ? known[4] : null };
  } else {
    const clean = titleCase(
      key
        .replace(/\b(pte\.?|ltd\.?|private|limited|singapore|sg|\(.*?\))\b/gi, " ")
        .replace(/[.,]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const name = clean || "Unknown provider";
    const short = name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    op = { key, name, short: short || "?", color: `hsl(${h % 360} 45% 42%)`, logo: null };
  }
  opCache.set(key, op);
  return op;
}

export function plugLabel(type: string): string {
  if (/combo\s*2|ccs\s*2|ccs/i.test(type)) return "CCS2";
  if (/chademo/i.test(type)) return "CHAdeMO";
  if (/type\s*2/i.test(type)) return "Type 2";
  if (/type\s*1|j1772/i.test(type)) return "Type 1";
  if (/gb\/?t/i.test(type)) return "GB/T";
  return type || "Unknown";
}

export function speedTier(kw: number | null): SpeedTier {
  if (kw === null || kw <= 0) return 0;
  if (kw < 11) return 1;
  if (kw < 50) return 2;
  return 3;
}

export function tierLabel(tier: SpeedTier): string {
  return ["Unknown", "Slow", "Fast", "Rapid"][tier];
}

export function formatKw(kw: number | null): string {
  if (kw === null) return "— kW";
  return `${Number.isInteger(kw) ? kw : kw.toFixed(1)} kW`;
}

export function isFreePrice(plug: Pick<Plug, "price" | "priceType">): boolean {
  return plug.priceType === "free" || plug.price === 0;
}

export function formatPrice(plug: Pick<Plug, "price" | "priceType">): { text: string; unit: string; kind: "free" | "na" | "paid" } {
  if (isFreePrice(plug)) return { text: "Free", unit: "", kind: "free" };
  if (plug.price === null) return { text: "Price not listed", unit: "", kind: "na" };
  return { text: `$${plug.price.toFixed(2)}`, unit: `/${plug.priceType || "kWh"}`, kind: "paid" };
}

export function summarize(st: Station): Summary {
  let free = 0;
  let busy = 0;
  let offline = 0;
  let maxKw: number | null = null;
  let hasDC = false;
  let minPrice: number | null = null;
  const plugTypes = new Set<string>();
  const operators = new Set<string>();
  for (const pt of st.points) {
    if (pt.operator) operators.add(pt.operator);
    for (const pl of pt.plugs) {
      plugTypes.add(plugLabel(pl.type));
      if (pl.current === "DC") hasDC = true;
      if (pl.kw !== null && (maxKw === null || pl.kw > maxKw)) maxKw = pl.kw;
      const price = isFreePrice(pl) ? 0 : pl.price;
      if (price !== null && (minPrice === null || price < minPrice)) minPrice = price;
      for (const c of pl.connectors) {
        if (c.s === 1) free++;
        else if (c.s === 0) busy++;
        else offline++;
      }
    }
  }
  const usable = free + busy;
  const ratio = usable ? free / usable : 0;
  let state: Availability;
  if (usable === 0) state = "offline";
  else if (free === 0) state = "busy";
  else if (ratio < 0.34 && usable > 2) state = "few";
  else state = "free";
  return {
    free,
    busy,
    offline,
    total: free + busy + offline,
    ratio,
    state,
    maxKw,
    tier: speedTier(maxKw),
    hasDC,
    plugTypes: [...plugTypes],
    operators: [...operators],
    minPrice,
  };
}

const ACRONYMS = new Set(["MSCP", "HDB", "MRT", "LRT", "NTUC", "CDG", "EV", "URA", "JTC", "NUS", "NTU", "SMU", "SUTD", "SIT", "SGH", "CBD", "ITE", "LTA", "PUB", "NEA", "SAF", "SAFRA", "SP", "SPH", "OCBC", "UOB", "DBS", "POSB", "IKEA", "IMM", "JEM", "SIM", "RWS", "ECP", "PIE", "AYE", "CTE", "BKE", "KPE", "TPE", "SLE", "MCE", "NSL", "EWL", "CP", "MSCPS", "B1", "B2", "B3", "B4", "L1", "L2", "L3", "L4", "L5", "L6", "UE", "OUE", "CT", "DUO", "YTL"]);

/** "BLK 142A PASIR RIS ST 11 MULTI STOREY CAR PARK" → "Blk 142A Pasir Ris St 11 Multi Storey Car Park". */
export function prettyName(s: string): string {
  if (!s || /[a-z]/.test(s)) return s; // already mixed case — trust it
  return s
    .toLowerCase()
    .replace(/[a-z0-9'+&]+/g, (w) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      if (/^\d+[a-z]{1,2}$/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w)) return up; // 142a → 142A
      if (/^[a-z]\d+$/.test(w)) return up; // b2, l4
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .replace(/\bMc([a-z])/g, (_, c: string) => `Mc${c.toUpperCase()}`);
}

export function toViewModels(payload: ChargersPayload): StationVM[] {
  return payload.stations.map((st) => {
    const sum = summarize(st);
    const ops = sum.operators.map((o) => operatorInfo(o).name).join(" ");
    return {
      ...st,
      name: prettyName(st.name),
      address: prettyName(st.address),
      sum,
      hay: `${st.name} ${st.address} ${st.postal} ${ops} ${sum.plugTypes.join(" ")}`.toLowerCase(),
    };
  });
}

export function availabilityText(s: Summary): string {
  if (s.state === "offline") return "Out of service";
  if (s.free === 0) return `All ${s.free + s.busy} in use`;
  return `${s.free}/${s.free + s.busy} free`;
}

export function availabilityA11y(s: Summary): string {
  if (s.state === "offline") return "all chargers out of service";
  return `${s.free} of ${s.free + s.busy} chargers free`;
}

// ── Geography ──────────────────────────────────────────────────────────

export interface LngLat {
  lng: number;
  lat: number;
}

export function distanceM(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 9950) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// ── Filtering ──────────────────────────────────────────────────────────

export interface Filters {
  freeNow: boolean;
  dc: boolean;
  minKw: 0 | 22 | 50 | 100;
  operators: string[];
  favourites: boolean;
}

export const DEFAULT_FILTERS: Filters = { freeNow: false, dc: false, minKw: 0, operators: [], favourites: false };

export function matchesFilters(st: StationVM, f: Filters, favs: ReadonlySet<string>): boolean {
  if (f.freeNow && st.sum.free === 0) return false;
  if (f.dc && !st.sum.hasDC) return false;
  if (f.minKw && (st.sum.maxKw ?? 0) < f.minKw) return false;
  if (f.favourites && !favs.has(st.id)) return false;
  if (f.operators.length) {
    const names = st.sum.operators.map((o) => operatorInfo(o).name);
    if (!f.operators.some((o) => names.includes(o))) return false;
  }
  return true;
}

export function searchStations(list: StationVM[], q: string, limit = 6): StationVM[] {
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: Array<[number, StationVM]> = [];
  for (const st of list) {
    if (!terms.every((t) => st.hay.includes(t))) continue;
    const name = st.name.toLowerCase();
    let score = 0;
    if (name.startsWith(terms[0])) score += 3;
    if (st.postal.startsWith(terms[0])) score += 3;
    if (name.includes(terms.join(" "))) score += 2;
    score += st.sum.free > 0 ? 1 : 0;
    scored.push([score, st]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, limit)
    .map(([, s]) => s);
}

/** Groups a station's plugs by (type, kW, price) for the detail view. */
export interface PlugGroup {
  key: string;
  label: string;
  current: string;
  kw: number | null;
  plug: Plug;
  operator: string;
  connectors: Array<{ id: string; s: 0 | 1 | null; position: string }>;
}

export function groupPlugs(st: Station): PlugGroup[] {
  const map = new Map<string, PlugGroup>();
  for (const pt of st.points) {
    for (const pl of pt.plugs) {
      const key = `${pt.operator}|${plugLabel(pl.type)}|${pl.kw}|${pl.price}|${pl.priceType}`;
      let g = map.get(key);
      if (!g) {
        g = { key, label: plugLabel(pl.type), current: pl.current, kw: pl.kw, plug: pl, operator: pt.operator, connectors: [] };
        map.set(key, g);
      }
      for (const c of pl.connectors) g.connectors.push({ ...c, position: pt.position });
    }
  }
  // Fastest first, then most free.
  return [...map.values()].sort((a, b) => (b.kw ?? 0) - (a.kw ?? 0) || a.label.localeCompare(b.label));
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
