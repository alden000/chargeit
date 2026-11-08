-- Charger alerts (see worker/src/alerts.ts). One row per watch a phone set up.
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,      -- random, unguessable; the phone keeps it to stop the watch
  endpoint TEXT NOT NULL,   -- the phone's push subscription
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  station TEXT NOT NULL,    -- station id, for the link in the notification
  name TEXT NOT NULL,       -- station name, for the notification text
  connectors TEXT NOT NULL, -- JSON array of watched connector ids
  labels TEXT NOT NULL,     -- JSON {connector id: lot label}
  event INTEGER NOT NULL,   -- 1 = alert when one becomes free, 0 = when one is taken, 2 = either
  once INTEGER NOT NULL,    -- 1 = stop after the first alert
  expires INTEGER NOT NULL, -- minutes since epoch
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS watches_endpoint ON watches (endpoint);
CREATE INDEX IF NOT EXISTS watches_expires ON watches (expires);
