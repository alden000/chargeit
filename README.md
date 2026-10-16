<p align="center"><img src="public/icons/icon-192.png" width="96" alt="ChargeIt logo"/></p>

# ChargeIt

**Find a free EV charger near you, right now.** ChargeIt is an installable mobile
web app (PWA) that shows every public EV charging point in Singapore. For each
one you can see live availability, charging speed, the charge provider and the
price, on a map built for one-handed use.

**Live app:** https://alden000.github.io/chargeit/
**Demo snapshot (works without the API):** https://alden000.github.io/chargeit/?demo

| | |
|---|---|
| 🟢 **Live availability** | A ring around each pin shows free (Volt) versus in use (Ember). It refreshes every 60 s from LTA's feed, which LTA updates about every 5 minutes. |
| ⚡ **Speed** | The kW rating is shown with ⚡/⚡⚡/⚡⚡⚡ tiers, plus AC/DC and the plug type (Type 2, CCS2, CHAdeMO). |
| 🏷️ **Provider & price** | Friendly provider names (SP Mobility, Charge+, CDG ENGIE, Shell Recharge…) and the price per kWh, when LTA publishes one. |
| 🔎 **Find** | Search by charger name, postal code or any place (OneMap). Filter by *Free now*, *DC fast*, minimum kW, provider or *Saved*. |
| 🧭 **Go** | One-tap directions in Google Maps, Apple Maps or Waze, and shareable deep links (`#s=<station>`). |
| 📴 **Offline-ready** | Installable PWA. The app shell and map are cached, and when you're offline it shows the last data it saw, clearly labelled. |

The creative direction (concept, complementary palette, logo, motion system and
microcopy) is in **[docs/CREATIVE.md](docs/CREATIVE.md)**.

## Architecture

```
Phone (PWA on GitHub Pages) ──► Cloudflare Worker (holds LTA key) ──► LTA DataMall EVCBatch
                                  edge cache 60 s · last-good 24 h       (link → signed S3 file)
```

* **`worker/`**: the Cloudflare Worker `chargeit-lta-proxy`. The LTA
  `AccountKey` exists **only** as the Cloudflare secret `LTA_ACCOUNT_KEY`. It is
  never in this repo, in the browser bundle or in GitHub Actions. The Worker
  makes about one upstream pull per minute per edge location, however many
  people use the app.
* **`shared/`**: the normaliser that turns LTA's file into a compact schema.
  The Worker and the tests both use it.
* **`src/`**: the app itself (Vite + TypeScript + MapLibre GL, with no UI
  framework).

## Setup (one time)

### 1. Deploy the Worker with your LTA key

Use the same LTA DataMall key as the WhereIsTheBus proxy. Cloudflare doesn't
let you read a secret back out of another Worker, so you paste the same value
again:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY   # paste your LTA DataMall AccountKey
npx wrangler deploy
```

`wrangler.toml` serves the Worker at **`https://chargeit-proxy.1313277.xyz`**,
on the same Cloudflare zone as the WhereIsTheBus proxy. The app uses that URL
by default. To check it's working, open
`https://chargeit-proxy.1313277.xyz/health` and look for
`"keyConfigured": true`.

If you'd rather use the Cloudflare dashboard, see [worker/README.md](worker/README.md).

### 2. Turn on GitHub Pages

Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. Every
push to `main` (or to this feature branch) then runs the full QA suite and
deploys.

> If the deploy job says the branch isn't allowed to deploy, go to
> **Settings → Environments → github-pages** and add the branch under
> *Deployment branches*.

### Optional settings

* **Repo variable `API_BASE`** (Settings → Secrets and variables → Actions →
  Variables): set this if the Worker lives at a different URL, for example
  `https://chargeit-lta-proxy.<you>.workers.dev`. It's a public URL, not a
  secret.
* **Repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`**: set these
  if you want `worker/` changes to auto-deploy. Without them, that workflow
  skips itself.

## Develop

```bash
npm install
npm run dev            # http://localhost:5173 (talks to the deployed Worker; add ?demo to work offline)
npm run typecheck
npm test               # unit tests: normaliser, model, Worker (mocked LTA)
npm run test:e2e       # Playwright on Android, iPhone and desktop viewports
npm run build
```

The QA suite has 39 unit tests and 44 end-to-end tests. Among other things it
checks the following:
* the key never appears in Worker responses, error messages or the built bundle
* the Worker shares one upstream pull across simultaneous requests, serves the
  last good copy when LTA fails, and sets CORS per request origin
* the main user journeys: filters, search, detail view, favourites, deep links,
  dragging the sheet, theme, offline behaviour, the error state and demo mode
* PWA installability (manifest and icons), the service worker working offline,
  touch-target size, accessible names, and no horizontal overflow

To regenerate the icons: `npm run icons`. To rebuild the demo snapshot from a
CSV capture: `npm run fixture -- <file.csv.gz>`.

## Data & credits

* Charging data: contains information from **LTA DataMall** accessed on an
  ongoing basis, made available under the
  [Singapore Open Data Licence](https://data.gov.sg/open-data-licence).
* Place search: [OneMap](https://www.onemap.gov.sg/) © Singapore Land Authority.
* Map: [OpenFreeMap](https://openfreemap.org/) · © [OpenMapTiles](https://openmaptiles.org/) · © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
* The demo snapshot is a real LTA feed capture from 2 Oct 2026, 19:15 SGT.
