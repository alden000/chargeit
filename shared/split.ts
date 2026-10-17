/**
 * The snapshot is ~2.4 MB, but only connector availability changes every
 * 5 minutes. So the API serves it in two parts:
 *
 *   /v1/stations → everything except availability (~270 KB gzipped), versioned
 *                  by `sv`, a hash of its content; it changes rarely.
 *   /v1/status   → `sv` + one character per connector (~5 KB gzipped).
 *
 * The app keeps the stations file and re-downloads it only when `sv` changes,
 * then lays the status string over it. Connectors are visited in the same
 * order on both sides: stations → points → plugs → connectors.
 */
import type { ChargersPayload, Station } from "./schema";

export interface StationsPayload {
  v: 1;
  sv: string;
  stations: Station[];
}

export interface StatusPayload {
  v: 1;
  sv: string;
  feedUpdated: string | null;
  fetchedAt: string;
  /** "1" free, "0" in use, "-" unknown — one per connector, in order. */
  s: string;
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
