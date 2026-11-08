/**
 * Charger alerts, phone side. A watch is registered with the proxy together
 * with this browser's push subscription; the proxy pushes when a watched
 * charger frees up or is taken, even with the app closed. Watches are also
 * remembered here (id, what, until when) so the app can list and stop them.
 */
import { API_BASE } from "./api.ts";

export type AlertEvent = 0 | 1; // 1 = becomes free, 0 = is taken

export interface LocalWatch {
  id: string;
  station: string;
  name: string;
  /** "any charger" or e.g. "lot L3A 82" */
  what: string;
  event: AlertEvent;
  expires: number; // epoch ms
}

const KEY = "chargeit:watches";

export function loadWatches(now = Date.now()): LocalWatch[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (w): w is LocalWatch =>
          !!w &&
          typeof w === "object" &&
          typeof w.id === "string" &&
          /^[A-Za-z0-9_-]{16,40}$/.test(w.id) &&
          typeof w.station === "string" &&
          typeof w.name === "string" &&
          typeof w.what === "string" &&
          (w.event === 0 || w.event === 1) &&
          typeof w.expires === "number",
      )
      .map((w) => ({ id: w.id, station: w.station.slice(0, 40), name: w.name.slice(0, 80), what: w.what.slice(0, 40), event: w.event, expires: w.expires }))
      .filter((w) => w.expires > now);
  } catch {
    return [];
  }
}

function saveWatches(ws: LocalWatch[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ws));
  } catch {
    /* storage unavailable: alerts still work, the list just isn't remembered */
  }
}

export type Support = { ok: true } | { ok: false; reason: "unsupported" | "ios-install" | "denied" };

/** Can this browser receive alerts with the app closed? */
export function pushSupport(): Support {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: ios && !standalone ? "ios-install" : "unsupported" };
  }
  if (ios && !standalone) return { ok: false, reason: "ios-install" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  return { ok: true };
}

async function subscription(): Promise<PushSubscription> {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("The app's background worker isn't ready yet. Reload and try again.")), 8000)),
  ]);
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  const res = await fetch(`${API_BASE}/v1/push/key`);
  if (!res.ok) throw new Error("Alerts aren't available right now.");
  const { key } = (await res.json()) as { key: string };
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
}

export interface NewWatch {
  station: string;
  name: string;
  connectors: string[];
  labels: Record<string, string>;
  what: string;
  event: AlertEvent;
  minutes: number;
  once: boolean;
}

/** Asks for notification permission if needed, then registers the watch. */
export async function startWatch(w: NewWatch): Promise<LocalWatch> {
  if (Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    if (p !== "granted") throw new Error("Notifications are off for ChargeIt. Allow them in your browser settings to get alerts.");
  }
  const sub = await subscription();
  const res = await fetch(`${API_BASE}/v1/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), station: w.station, name: w.name, connectors: w.connectors, labels: w.labels, event: w.event, minutes: w.minutes, once: w.once }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; expires?: number; error?: string };
  if (!res.ok || !body.id || !body.expires) throw new Error(body.error ? `Couldn't set the alert: ${body.error}.` : "Couldn't set the alert. Try again.");
  const local: LocalWatch = { id: body.id, station: w.station, name: w.name, what: w.what, event: w.event, expires: body.expires };
  saveWatches([...loadWatches(), local]);
  return local;
}

export async function stopWatch(id: string): Promise<void> {
  saveWatches(loadWatches().filter((w) => w.id !== id));
  await fetch(`${API_BASE}/v1/watch?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Drops watches the proxy no longer has (fired once, or forgotten). Best effort. */
export async function syncWatches(): Promise<LocalWatch[]> {
  const local = loadWatches();
  if (!local.length) return local;
  try {
    const res = await fetch(`${API_BASE}/v1/watch?ids=${local.map((w) => w.id).join(",")}`, { cache: "no-store" });
    if (!res.ok) return local;
    const { active } = (await res.json()) as { active?: unknown };
    if (!Array.isArray(active)) return local;
    const keep = local.filter((w) => active.includes(w.id));
    saveWatches(keep);
    return keep;
  } catch {
    return local;
  }
}
