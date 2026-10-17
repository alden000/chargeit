import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyStatus, type StationsPayload, type StatusPayload } from "../../shared/split.ts";
import worker, { __resetForTests, freshTtlSeconds, type Env } from "../../worker/src/index.ts";

const KEY = "test-secret-account-key-123";
const LINK = "https://dmprod-datasets.s3.ap-southeast-1.amazonaws.com/ev-batch/file.json?sig=abc";
const FILE = {
  LastUpdatedTime: "2026-10-02 19:15:00",
  evLocationsData: [
    {
      name: "CLARKE QUAY",
      address: "3E RIVER VALLEY ROAD",
      postalCode: "179024",
      latitude: "1.290314",
      longtitude: "103.846728",
      chargingPoints: [{ operator: "SP", position: "L4", plugTypes: [{ plugType: "Type 2", current: "AC", powerRating: "22", price: "0.8", priceType: "kWh", evIds: [{ evCpId: "a", status: "1" }] }] }],
    },
  ],
};

class MemoryCache {
  store = new Map<string, Response>();
  async match(key: string) {
    const r = this.store.get(key);
    return r ? r.clone() : undefined;
  }
  async put(key: string, res: Response) {
    this.store.set(key, res.clone());
  }
}

let cache: MemoryCache;
let upstream: ReturnType<typeof vi.fn>;
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const env: Env = { LTA_ACCOUNT_KEY: KEY };

function req(path: string, origin = "https://chargeit.wwweeeiii.com", method = "GET") {
  return new Request(`https://chargeit-proxy.example${path}`, { method, headers: origin ? { Origin: origin } : {} });
}

function okUpstream() {
  upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://datamall2.mytransport.sg/")) {
      expect((init?.headers as Record<string, string>).AccountKey).toBe(KEY);
      return Response.json({ "odata.metadata": "x", value: [{ Link: LINK }] });
    }
    if (url === LINK) return Response.json(FILE);
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", upstream);
}

beforeEach(() => {
  __resetForTests();
  cache = new MemoryCache();
  vi.stubGlobal("caches", { default: cache });
  waits.length = 0;
  okUpstream();
});
afterEach(() => vi.unstubAllGlobals());

describe("worker /v1/chargers", () => {
  it("does the two-step EVCBatch fetch and returns the normalised payload with CORS", async () => {
    const res = await worker.fetch(req("/v1/chargers"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://chargeit.wwweeeiii.com");
    expect(res.headers.get("X-Stale")).toBe("0");
    const body = (await res.json()) as { stations: unknown[]; feedUpdated: string };
    expect(body.stations).toHaveLength(1);
    expect(body.feedUpdated).toBe("2026-10-02T11:15:00.000Z");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never leaks the account key or the signed link to clients", async () => {
    const res = await worker.fetch(req("/v1/chargers"), env, ctx);
    const text = await res.text();
    const headers = JSON.stringify([...res.headers.entries()]);
    expect(text).not.toContain(KEY);
    expect(headers).not.toContain(KEY);
    expect(text).not.toContain("sig=abc");
  });

  it("does not grant CORS to unknown origins", async () => {
    const res = await worker.fetch(req("/v1/chargers", "https://evil.example"), env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("coalesces concurrent requests into one upstream pull and serves repeats from memory", async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => worker.fetch(req("/v1/chargers"), env, ctx)));
    await worker.fetch(req("/v1/chargers"), env, ctx);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("serves the edge-cached copy to a fresh isolate without calling LTA", async () => {
    await worker.fetch(req("/v1/chargers"), env, ctx);
    await Promise.all(waits);
    __resetForTests();
    upstream.mockClear();
    const res = await worker.fetch(req("/v1/chargers", "http://localhost:5173"), env, ctx);
    expect(res.status).toBe(200);
    // Same cached body, but CORS reflects *this* request's origin.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("falls back to the last good copy when LTA fails", async () => {
    await worker.fetch(req("/v1/chargers"), env, ctx);
    await Promise.all(waits);
    __resetForTests();
    for (const k of [...cache.store.keys()]) if (k.includes("/fresh/")) cache.store.delete(k);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const res = await worker.fetch(req("/v1/chargers"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Stale")).toBe("1");
    expect(((await res.json()) as { stations: unknown[] }).stations).toHaveLength(1);
  });

  it("returns a generic 503 when LTA fails and nothing is cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid AccountKey " + KEY, { status: 401 })));
    const res = await worker.fetch(req("/v1/chargers"), env, ctx);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe('{"error":"upstream_unavailable"}');
  });

  it("returns 503 when the secret isn't configured, without calling LTA", async () => {
    const res = await worker.fetch(req("/v1/chargers"), { LTA_ACCOUNT_KEY: "" }, ctx);
    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("handles gzip files served without Content-Encoding", async () => {
    const gz = await new Response(new Blob([JSON.stringify(FILE)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === LINK ? new Response(gz) : Response.json({ value: [{ Link: LINK }] }))),
    );
    const res = await worker.fetch(req("/v1/chargers"), env, ctx);
    expect(((await res.json()) as { stations: unknown[] }).stations).toHaveLength(1);
  });
});

describe("worker resilience (QA #2, #3)", () => {
  it("gives up on a hung LTA within the deadline and serves the last good copy", async () => {
    await worker.fetch(req("/v1/chargers"), env, ctx);
    await Promise.all(waits);
    __resetForTests();
    for (const k of [...cache.store.keys()]) if (k.includes("/fresh/")) cache.store.delete(k);
    vi.useFakeTimers();
    // Headers arrive, but the body never does.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
    const pending = worker.fetch(req("/v1/chargers"), env, ctx);
    await vi.advanceTimersByTimeAsync(8_100);
    vi.useRealTimers();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Stale")).toBe("1");
  });

  it("backs off after a failure instead of hitting LTA on every request", async () => {
    const down = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", down);
    expect((await worker.fetch(req("/v1/chargers"), env, ctx)).status).toBe(503);
    const calls = down.mock.calls.length;
    expect((await worker.fetch(req("/v1/chargers"), env, ctx)).status).toBe(503);
    expect((await worker.fetch(req("/v1/chargers"), env, ctx)).status).toBe(503);
    expect(down.mock.calls.length).toBe(calls);
  });
});

describe("worker misc routes", () => {
  it("answers CORS preflight", async () => {
    const res = await worker.fetch(req("/v1/chargers", "https://chargeit.wwweeeiii.com", "OPTIONS"), env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
  it("rejects writes", async () => {
    const res = await worker.fetch(req("/v1/chargers", "", "POST"), env, ctx);
    expect(res.status).toBe(405);
  });
  it("health reports whether the key is configured, never the key", async () => {
    const res = await worker.fetch(req("/health"), env, ctx);
    const text = await res.text();
    expect(JSON.parse(text).keyConfigured).toBe(true);
    expect(text).not.toContain(KEY);
  });
  it("404s unknown paths", async () => {
    expect((await worker.fetch(req("/nope"), env, ctx)).status).toBe(404);
  });
});

describe("cache lifetime follows LTA's 5-minute snapshots", () => {
  const T = (iso: string) => Date.parse(iso);
  it("worker reuses a pull only until the next snapshot is out (15–60 s)", () => {
    const stamp = "2026-10-17T05:05:00.000Z";
    expect(freshTtlSeconds(stamp, T("2026-10-17T05:05:30Z"))).toBe(60); // plenty of time: full minute
    expect(freshTtlSeconds(stamp, T("2026-10-17T05:10:00Z"))).toBe(40); // expire right as 05:10 lands
    expect(freshTtlSeconds(stamp, T("2026-10-17T05:11:00Z"))).toBe(15); // LTA late: re-check soon
  });
});

describe("split endpoints: /v1/stations + /v1/status", () => {
  it("status is tiny and fits the stations it names; combined equals /v1/chargers", async () => {
        const full = await (await worker.fetch(req("/v1/chargers"), env, ctx)).json();
    const statusRes = await worker.fetch(req("/v1/status"), env, ctx);
    const status = (await statusRes.json()) as StatusPayload;
    expect(status.s).toBe("1");
    expect(statusRes.headers.get("Access-Control-Expose-Headers")).toContain("X-SV");
    const stationsRes = await worker.fetch(req(`/v1/stations?v=${status.sv}`), env, ctx);
    expect(stationsRes.headers.get("Cache-Control")).toContain("immutable");
    const stations = (await stationsRes.json()) as StationsPayload;
    expect(stations.sv).toBe(status.sv);
    expect(JSON.stringify(stations)).not.toMatch(/"s":[01]/); // no availability in the big file
    expect(applyStatus(stations, status)).toEqual(full);
    expect(upstream).toHaveBeenCalledTimes(2); // one LTA pull served all three
  });

  it("unversioned or outdated stations requests get a short cache", async () => {
    const res = await worker.fetch(req("/v1/stations?v=old"), env, ctx);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("serves all parts from the last good copy when LTA fails", async () => {
    await worker.fetch(req("/v1/status"), env, ctx);
    await Promise.all(waits);
    for (const k of [...cache.store.keys()]) if (k.includes("/fresh/")) cache.store.delete(k);
    __resetForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const res = await worker.fetch(req("/v1/status"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Stale")).toBe("1");
    expect(((await res.json()) as StatusPayload).s).toBe("1");
  });
});
