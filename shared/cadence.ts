/**
 * LTA republishes EVCBatch on every 5-minute mark (:00, :05, …), stamped with
 * that mark, and the new file is downloadable ~30 s later. Both the Worker's
 * cache lifetime and the app's refresh timer key off this, so a fresh snapshot
 * reaches the screen within about a minute instead of up to ~2 minutes late.
 */
export const FEED_PERIOD_MS = 5 * 60_000;
/** Measured ~30 s from the mark to availability; a little headroom on top. */
export const FEED_LAG_MS = 40_000;

/**
 * When the snapshot after the one stamped `feedUpdated` should be fetchable.
 * Without a usable stamp, falls back to the wall-clock 5-minute grid.
 */
export function nextFeedAt(feedUpdated: string | null | undefined, now: number): number {
  const t = feedUpdated ? Date.parse(feedUpdated) : NaN;
  const mark = Number.isFinite(t) ? t : Math.floor((now - FEED_LAG_MS) / FEED_PERIOD_MS) * FEED_PERIOD_MS;
  return mark + FEED_PERIOD_MS + FEED_LAG_MS;
}
