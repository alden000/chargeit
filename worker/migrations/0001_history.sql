-- Charger history (see worker/src/history.ts). Everything is indexed by a
-- connector's position in the append-only `ids` list.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,   -- 'ids' (JSON array of connector ids), 'state' (binary)
  v BLOB NOT NULL,
  updated INTEGER NOT NULL
);
-- One row per hour of the week (0 = Monday 00:00 SGT): how often each
-- connector was seen, and seen in use, in that hour.
CREATE TABLE IF NOT EXISTS slots (
  slot INTEGER PRIMARY KEY,
  busy BLOB NOT NULL,
  seen BLOB NOT NULL
);
-- One row per LTA snapshot: the connectors whose state changed, so anything
-- can be recomputed later. Pruned after ~13 months.
CREATE TABLE IF NOT EXISTS changes (
  ts INTEGER PRIMARY KEY, -- snapshot time, minutes since epoch
  data BLOB NOT NULL      -- repeated [uint32 index LE, uint8 state]
);
