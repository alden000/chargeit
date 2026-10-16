// Rebuilds an EVCBatch-shaped raw file from a flattened CSV snapshot, then
// normalises it into public/demo/chargers.json (the "demo snapshot" mode).
//   node scripts/make-fixture.ts <snapshot.csv.gz> [feed_updated]
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { normalizeBatch } from "../shared/normalize.ts";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const [csvPath, wanted] = process.argv.slice(2);
const rl = createInterface({ input: createReadStream(csvPath).pipe(createGunzip()) });
let header: string[] | null = null;
const rows: Record<string, string>[] = [];
for await (const line of rl) {
  const cells = parseCsvLine(line);
  if (!header) { header = cells; continue; }
  rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}
const feed = wanted ?? rows.reduce((m, r) => (r.feed_updated > m ? r.feed_updated : m), "");
const snap = rows.filter((r) => r.feed_updated === feed);

type Raw = Record<string, any>;
const stations = new Map<string, Raw>();
for (const r of snap) {
  let st = stations.get(r.station_key);
  if (!st) {
    st = { address: r.address, name: r.station_name, longtitude: r.longitude, latitude: r.latitude, postalCode: r.postal_code, chargingPoints: [] };
    stations.set(r.station_key, st);
  }
  const cpKey = `${r.operator}|${r.position}`;
  let cp = st.chargingPoints.find((c: Raw) => c._k === cpKey);
  if (!cp) {
    cp = { _k: cpKey, status: r.charger_status, operatingHours: r.operating_hours, operator: r.operator, position: r.position, name: r.station_name, plugTypes: [] };
    st.chargingPoints.push(cp);
  }
  const pKey = `${r.plug_type}|${r.power_rating_kw}|${r.price}`;
  let plug = cp.plugTypes.find((p: Raw) => p._k === pKey);
  if (!plug) {
    plug = { _k: pKey, plugType: r.plug_type, price: r.price, current: r.current, powerRating: r.power_rating_kw, priceType: r.price_type, evIds: [] };
    cp.plugTypes.push(plug);
  }
  plug.evIds.push({ evCpId: r.ev_cp_id, status: r.connector_status });
}
const raw = JSON.parse(JSON.stringify({ LastUpdatedTime: feed, evLocationsData: [...stations.values()] }, (k, v) => (k === "_k" ? undefined : v)));
const payload = normalizeBatch(raw, new Date(`${feed.replace(" ", "T")}+08:00`));
await mkdir(new URL("../public/demo/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/demo/chargers.json", import.meta.url), JSON.stringify(payload));
const connectors = payload.stations.reduce((n, s) => n + s.points.reduce((m, p) => m + p.plugs.reduce((k, pl) => k + pl.connectors.length, 0), 0), 0);
console.log(`feed ${feed}: ${payload.stations.length} stations, ${connectors} connectors`);
