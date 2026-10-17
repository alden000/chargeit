/**
 * The snapshot is ~2.4 MB, but only connector availability changes every
 * 5 minutes. So the API serves it in two parts:
 *
 *   /v1/stations → everything except availability (~270 KB gzipped).
 *   /v1/status   → one character per connector (~2 KB gzipped).
 *
 * Both carry two versions of the stations file:
 *   sv — its layout: which sites and connectors, in which order. The status
 *        string only lines up with a stations file of the same sv, so a change
 *        means "re-download now". Changes only when chargers come or go.
 *   cv — its full content. LTA flips names/coordinates of some sites between
 *        snapshots, so this changes often; the app picks it up at most hourly.
 *
 * Connectors are visited in the same order on both sides: stations → points →
 * plugs → connectors (normalizeBatch sorts all of them).
 */
import type { ChargersPayload, Station } from "./schema";

export interface StationsPayload {
  v: 1;
  sv: string;
  cv: string;
  stations: Station[];
}

export interface StatusPayload {
  v: 1;
  sv: string;
  cv: string;
  feedUpdated: string | null;
  fetchedAt: string;
  /** "1" free, "0" in use, "-" unknown — one per connector, in order. */
  s: string;
}

/** What `sv` hashes: site ids and their connector ids, in order. */
export function layoutKey(stations: readonly Station[]): string {
  const out: string[] = [];
  for (const st of stations) out.push(`${st.id}:${st.points.map((pt) => pt.plugs.map((pl) => pl.connectors.map((c) => c.id).join(",")).join("|")).join("/")}`);
  return out.join(";");
}

export function statusString(stations: readonly Station[]): string {
  const out: string[] = [];
  for (const st of stations) for (const pt of st.points) for (const pl of pt.plugs) for (const c of pl.connectors) out.push(c.s === 1 ? "1" : c.s === 0 ? "0" : "-");
  return out.join("");
}

/**
 * Availability-free version of `JSON.stringify(stations)`, done on the string:
 * re-serialising 2.4 MB of objects would blow the Worker's CPU budget. Only
 * connectors have an `"s"` key, and quotes inside string values are escaped,
 * so this can't touch anything else.
 */
export function stripStatusJson(stationsJson: string): string {
  return stationsJson.replace(/"s":(?:0|1|null)\}/g, '"s":null}');
}

/** Combines the two parts; null when the status doesn't fit these stations (refetch them). */
export function applyStatus(stations: StationsPayload, status: StatusPayload): ChargersPayload | null {
  if (status.sv !== stations.sv || typeof status.s !== "string") return null;
  let i = 0;
  const s = status.s;
  const out: Station[] = [];
  for (const st of stations.stations) {
    out.push({
      ...st,
      points: st.points.map((pt) => ({
        ...pt,
        plugs: pt.plugs.map((pl) => ({
          ...pl,
          connectors: pl.connectors.map((c) => {
            const ch = s[i++];
            return { id: c.id, s: ch === "1" ? 1 : ch === "0" ? 0 : null };
          }),
        })),
      })),
    });
  }
  if (i !== s.length) return null;
  return { v: 1, feedUpdated: status.feedUpdated, fetchedAt: status.fetchedAt, stations: out };
}
