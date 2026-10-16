# chargeit-lta-proxy (Cloudflare Worker)

This Worker keeps the LTA DataMall `AccountKey` server-side and serves the
ChargeIt app a compact, cached snapshot of every EV charging point in
Singapore.

| Route | What it returns |
|---|---|
| `GET /v1/chargers` | `{ v, feedUpdated, fetchedAt, stations[] }` (see `shared/schema.ts`). The headers `X-Feed-Updated`, `X-Fetched-At` and `X-Stale` describe the data. |
| `GET /health` | `{ ok, keyConfigured, feedUpdated, fetchedAt }`. It reports whether a key is configured, never the key itself. |

## How it works

1. `GET https://datamall2.mytransport.sg/ltaodataservice/EVCBatch` with the
   `AccountKey` header returns a short-lived signed **Link** (LTA's two-step
   batch API).
2. The Worker downloads that file. It can handle a gzip file served without a
   `Content-Encoding` header.
3. `shared/normalize.ts` flattens the file. It deals with LTA's quirks, such as
   `longtitude`, `evIds` nested inside `plugTypes`, `""` status meaning
   out of service, and prices given as strings.
4. The result is cached in the Workers Cache API for **60 s**. LTA refreshes
   the feed about every 5 minutes. A separate **last-good** copy is kept for
   24 h and served (marked `X-Stale: 1`) if LTA errors.
5. Concurrent requests on one isolate share a single upstream pull.

That works out to at most about 2 subrequests per minute per edge location,
which is comfortably within the Workers Free plan.

The cached body carries no CORS headers. CORS is added per request from the
allow-list (`https://chargeit.wwweeeiii.com`, `https://alden000.github.io` and localhost dev ports), so one
origin can never poison the cache for another. To override the allow-list, set
the plain var `ALLOWED_ORIGINS` (comma-separated).

## Deploy with wrangler

```bash
npm install
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY    # same key as the WhereIsTheBus proxy
npx wrangler deploy
```

## Deploy from the dashboard

1. **Workers & Pages → Create → Worker**. Name it `chargeit-lta-proxy`.
2. **Settings → Variables and Secrets → Add → Secret**. Name it
   `LTA_ACCOUNT_KEY` and paste your key.
3. **Settings → Domains & Routes → Add → Custom domain**:
   `chargeit-proxy.1313277.xyz`. Or keep the `workers.dev` URL and set the repo
   variable `API_BASE` to it.
4. Deploy the code. The easiest way is `npx wrangler deploy` from this folder,
   since it bundles `../shared` for you.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # put your key in .dev.vars (gitignored)
npm run dev                      # http://localhost:8787/v1/chargers
```
