import type { ConnectorHistory, StationHistory } from "./api.ts";
import { escapeHtml } from "./motion.ts";

/** Chargers are in Singapore, so their history is shown in Singapore time whatever the device says. */
const TZ = "Asia/Singapore";
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first day index and hour in Singapore time. */
export function sgtParts(ms: number): { day: number; hour: number } {
  const local = new Date(ms + 8 * 3600_000);
  return { day: (local.getUTCDay() + 6) % 7, hour: local.getUTCHours() };
}

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "1h 20m" — fits inside a charger tile. */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "14:05" today, "Sat 14:05" another day (Singapore time). */
export function clock(ms: number, now = Date.now()): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(ms);
  const a = sgtParts(ms);
  const b = sgtParts(now);
  const sameDay = a.day === b.day && Math.abs(now - ms) < 86_400_000;
  return sameDay ? time : `${DAYS[a.day]} ${time}`;
}

export function hourLabel(h: number): string {
  const h12 = h % 12 || 12;
  return `${h12}${h < 12 ? "am" : "pm"}`;
}

/**
 * History only counts when it agrees with the live status: the two are
 * recorded a minute apart, and a contradiction is worse than saying nothing.
 */
function agrees(live: 0 | 1 | null, h: ConnectorHistory | null | undefined): h is ConnectorHistory {
  return !!h && live !== null && h.s === live;
}

/** Short duration for a charger tile: how long it has been in its current state. */
export function tileDuration(live: 0 | 1 | null, h: ConnectorHistory | null | undefined, now = Date.now()): string | null {
  return agrees(live, h) && h.since ? shortDuration(now - h.since) : null;
}

/** One or two sentences about a single charger's current and previous session. */
export function connectorStory(live: 0 | 1 | null, h: ConnectorHistory | null | undefined, now = Date.now()): string[] {
  const out: string[] = [];
  if (agrees(live, h)) {
    if (h.since) out.push(`${live === 0 ? "In use" : "Free"} since ${clock(h.since, now)} (${formatDuration(now - h.since)}).`);
    else out.push(`${live === 0 ? "In use" : "Free"} since before we started tracking it.`);
  }
  if (h?.last) {
    const end = clock(h.last.end, now);
    out.push(
      h.last.start
        ? `Previous session ${clock(h.last.start, now)}–${end} (${formatDuration(h.last.end - h.last.start)}).`
        : `Previous session ended ${end}.`,
    );
  }
  return out;
}

/** In-use % for each hour of one day: one connector, or the average across a station's connectors. */
export function dayProfile(hist: StationHistory, connectorIds: readonly string[], day: number): Array<number | null> {
  return Array.from({ length: 24 }, (_, hour) => {
    const vals = connectorIds.map((id) => hist.connectors[id]?.busy[day * 24 + hour]).filter((v): v is number => typeof v === "number");
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  });
}

/** "Usually busiest 6pm–9pm" from the 3-hour window with the highest average, if there's enough data. */
export function busiestWindow(profile: Array<number | null>): string | null {
  let best = -1;
  let at = -1;
  for (let h = 0; h + 3 <= 24; h++) {
    const w = profile.slice(h, h + 3);
    if (w.some((v) => v === null)) continue;
    const avg = (w as number[]).reduce((a, b) => a + b, 0) / 3;
    if (avg > best) [best, at] = [avg, h];
  }
  if (at < 0) return null;
  if (best < 15) return "Usually quiet all day";
  return `Usually busiest ${hourLabel(at)}–${hourLabel((at + 3) % 24)}`;
}

/** 24 bars; the current hour is marked when `nowHour` is given. */
export function chartHtml(profile: Array<number | null>, nowHour: number | null): string {
  const bars = profile
    .map((v, h) => {
      const label = `${hourLabel(h)}: ${v === null ? "no data yet" : `in use ${v}% of the time`}`;
      const level = v === null ? " is-empty" : v >= 60 ? " is-high" : v >= 30 ? " is-mid" : "";
      return `<span class="bh__bar${level}${h === nowHour ? " is-now" : ""}" style="--v:${v ?? 0}" title="${escapeHtml(label)}"></span>`;
    })
    .join("");
  return `<div class="bh__chart" role="img" aria-label="${escapeHtml(profile.map((v, h) => `${hourLabel(h)} ${v === null ? "no data" : `${v}%`}`).join(", "))}">${bars}</div>
    <div class="bh__axis" aria-hidden="true"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>
    <div class="bh__legend" aria-hidden="true"><span><i></i>Quiet</span><span><i class="is-mid"></i>Moderate</span><span><i class="is-high"></i>Busy</span></div>`;
}
