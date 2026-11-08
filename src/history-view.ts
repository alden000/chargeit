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
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "14:05" today, "Sat 14:05" within the week, "8 Nov" before that (Singapore time). */
export function clock(ms: number, now = Date.now()): string {
  if (now - ms > 6 * 86_400_000) return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(ms);
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

export interface TileFacts {
  /** How long in the current state, e.g. "1h 20m". */
  dur: string | null;
  /** True when that's a minimum: the state began before we saw it. */
  atLeast: boolean;
  /** "since 13:10" when we saw it begin. */
  since: string | null;
}

/** What a charger tile shows at a glance; empty when history doesn't match the live status. */
export function tileFacts(live: 0 | 1 | null, h: ConnectorHistory | null | undefined, now = Date.now()): TileFacts {
  if (!agrees(live, h)) return { dur: null, atLeast: false, since: null };
  if (h.since) return { dur: shortDuration(now - h.since), atLeast: false, since: `since ${clock(h.since, now)}` };
  if (h.sinceBefore) return { dur: shortDuration(now - h.sinceBefore), atLeast: true, since: null };
  return { dur: null, atLeast: false, since: null };
}

/** One or two sentences about a single charger's current and previous session. */
export function connectorStory(live: 0 | 1 | null, h: ConnectorHistory | null | undefined, now = Date.now()): string[] {
  const out: string[] = [];
  if (agrees(live, h)) {
    const what = live === 0 ? "In use" : "Free";
    if (h.since) out.push(`${what} since ${clock(h.since, now)} (${formatDuration(now - h.since)}).`);
    else if (h.sinceBefore) out.push(`${what} for at least ${formatDuration(now - h.sinceBefore)} (since before ${clock(h.sinceBefore, now)}).`);
  }
  const last = h?.last;
  if (last) {
    const end = clock(last.end, now);
    if (last.start) out.push(`Previous session ${clock(last.start, now)}–${end} (${formatDuration(last.end - last.start)}).`);
    else if (last.startBefore) out.push(`Previous session ended ${end}, after at least ${formatDuration(last.end - last.startBefore)}.`);
    else out.push(`Previous session ended ${end}.`);
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

/** "Busiest 6pm–9pm" from the 3-hour window with the highest average (ties: the one centred on the peak). */
export function busiestWindow(profile: Array<number | null>): string | null {
  let best = -1;
  let mid = -1;
  let at = -1;
  for (let h = 0; h + 3 <= 24; h++) {
    const w = profile.slice(h, h + 3);
    if (w.some((v) => v === null)) continue;
    const avg = (w as number[]).reduce((a, b) => a + b, 0) / 3;
    if (avg > best + 1e-9 || (Math.abs(avg - best) < 1e-9 && (w[1] as number) > mid)) [best, mid, at] = [avg, w[1] as number, h];
  }
  if (at < 0) return null;
  if (best < 15) return "Usually quiet";
  return `Busiest ${hourLabel(at)}–${hourLabel((at + 3) % 24)}`;
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
