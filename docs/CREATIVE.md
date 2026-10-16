# ChargeIt — Creative Direction

> **Find your spark.**
> A night-city instrument panel for finding a free charger in Singapore.

## 1. The idea

Singapore's EV network changes every few minutes. Most chargers sit in
multi-storey car parks, and drivers mainly want to know one thing: **is there
a free plug near me right now, and how fast is it?**

ChargeIt treats the map like a dashboard at night. The city is dark ink. The
chargers glow. A glowing point is a charger you can use, and a dim one is a
charger you can't. You should be able to tell what's around you in under a
second, without reading anything.

**Three principles**

1. **Color carries state.** Two complementary colors stand for the one
   question that matters: free or busy. They aren't used for decoration.
2. **Shapes carry speed.** Bolts (⚡, ⚡⚡, ⚡⚡⚡) show charging speed, so the
   colors stay reserved for availability.
3. **Motion explains.** Every animation tells you something, such as where you
   came from, what changed or what's live. Nothing moves just to look busy,
   and all of it turns off when `prefers-reduced-motion` is set.

## 2. Palette — a complementary pair

The palette is built on one complementary pair: **Volt** at hue 164° and
**Ember** at hue 344°, exactly opposite on the color wheel. The opposition
mirrors the app's core question: free versus busy, go versus wait.

| Token | Dark (default) | Light | Role |
|---|---|---|---|
| `--volt` | `#1CE8B5` | `#00A383` | Available · primary action · brand |
| `--ember` | `#FF4F7B` | `#E0335F` | Occupied · live signal · brand spark |
| `--amber` | `#FFC24B` | `#B97800` | Partially available (mix state) |
| `--offline` | `#5B6785` | `#9AA5BD` | Out of service / unknown |
| `--ink-950` | `#070B16` | `#F4F7FB` | App background |
| `--ink-900` | `#0C1324` | `#FFFFFF` | Surfaces (sheet, cards) |
| `--ink-800` | `#141D33` | `#EEF2F8` | Raised surfaces, chips |
| `--line` | `#24304D` | `#DCE3EE` | Hairlines |
| `--text` | `#EAF2FF` | `#0C1324` | Primary text |
| `--muted` | `#8A9BBD` | `#5B6785` | Secondary text |

The brand gradient is **Volt → Ember**. It appears only in the logo, the
splash "charge" moment and the refresh current line. Using it so rarely keeps
it special.

The map is restyled to match. Water is a deep blue-ink and roads are faint
slate lines, so the glowing pins are the brightest thing on screen.

## 3. Logo

**The mark** is a map pin with a lightning bolt cut out of it, so it reads as
both a location and a charger. A small Ember dot sits at the pin's shoulder.
It's the **spark**: the live signal, and the one place the complementary
color appears in the mark.

**The wordmark** is **Charge**<span>It</span> set in Space Grotesk Bold, with
"It" in Volt. It reads naturally as a command, "charge it."

Assets: `public/logo.svg` (mark), `public/icons/*` (PWA icons, including a
maskable icon with the mark inside the 80% safe zone).

## 4. Typography

* **Space Grotesk** (display, numbers): its technical, slightly
  instrument-like letterforms suit counts like `3/4 free` and `120 kW`.
* **Inter** (UI text): very legible at 13–15px on a phone.
* Numbers use `font-variant-numeric: tabular-nums` so counters don't shift
  around while they animate.

Both fonts are self-hosted (`@fontsource`), so they work offline and the app
makes no third-party font requests.

## 5. Information design

**Station pin.** This is a ring that shows availability:

* A Volt arc shows the share of connectors that are free, and an Ember arc
  shows the share in use. The center shows the free count.
* A fully free station glows and "breathes" slowly. A fully busy station is
  solid Ember with no glow. An out-of-service station is dimmed Slate.
* A DC fast station carries a small ⚡ badge.

**Cluster.** This is the same ring at a larger size, showing the total free
count for the area, so you can scan the whole island at low zoom.

**Speed tiers** (from `powerRating` kW):

| Tier | Range | Glyph | Label |
|---|---|---|---|
| Slow | < 11 kW | ⚡ | AC |
| Fast | 11–49 kW | ⚡⚡ | AC fast / DC |
| Rapid | ≥ 50 kW | ⚡⚡⚡ | DC rapid |

**Provider names.** Registered company names such as
`COMFORTDELGRO ENGIE PTE. LTD.` are mapped to the names drivers recognise,
such as **CDG ENGIE**. Each provider also gets a small monogram chip.

**Price.** Shown as `$0.65 /kWh`. "Free" is shown as a Volt badge. When the
feed has no price, the app says "Price not listed" rather than leaving a
blank.

## 6. Layout (mobile first)

```
┌─────────────────────────────┐
│ [logo] ChargeIt   ⟳ 2m  ☾  │  ← glass top bar, live "current" line on refresh
│ ┌─────────────────────────┐ │
│ │ 🔍 Search place, postal │ │  ← search
│ └─────────────────────────┘ │
│ (Free now) (DC fast) (≥50kW)│  ← filter chips, scroll horizontally
│                             │
│         MAP  ◉  ◎           │
│      ◎      (you)   ◉       │
│                       [◎]   │  ← locate-me FAB (radar ripple)
│ ╭───────────────────────╮   │
│ │ ▬  Nearby · 128 free   │   │  ← bottom sheet: peek / half / full
│ │ ◉ Clarke Quay   350 m  │   │
│ │   4/4 free · 50 kW · SP│   │
│ ╰───────────────────────╯   │
└─────────────────────────────┘
```

* **Thumb zone first:** the primary actions (locate, the sheet, filters) are
  all in the bottom two-thirds or within one tap of it.
* **Bottom sheet** with three snap points (peek 148px, half 52%, full 92%).
  It's draggable with spring physics, a fling snaps it, and it supports the
  keyboard and screen readers.
* **Station detail** opens in the same sheet. The list card morphs into the
  header (FLIP animation), and the connectors line up as "battery cells".
* **One-tap navigate**: Google Maps, Apple Maps or Waze deep link, plus Share.

## 7. Motion system

| Moment | Motion | Timing |
|---|---|---|
| **Splash "charge-up"** | The pin's outline draws on, the bolt fills Volt from the bottom like a charging battery, the spark flashes Ember, then the splash opens in a circular reveal onto the map | 1.1 s total, skipped on repeat visits within a session |
| **Map fly-in** | The map eases from an island-wide view into the user, with a 35° tilt and a 15° bearing | `flyTo` 1.6 s, `easeOutExpo` |
| **Locate me** | Two radar ripples spread out from the user dot, and the FAB spins once | 1.2 s |
| **Pins appear** | A staggered pop with an overshoot spring (`cubic-bezier(.34,1.56,.64,1)`) | 320 ms, 12 ms stagger |
| **Free pins breathe** | A soft Volt glow scales between 1.0 and 1.35 | 2.4 s loop |
| **Live refresh** | A Volt→Ember "current" line runs across the top bar. Changed counts tick and briefly flash their state color | 900 ms |
| **Sheet drag** | Spring physics (stiffness 380, damping 34). A fling past velocity 0.6 px/ms snaps to the next point | — |
| **Card → detail** | FLIP shared-element morph, then the connector cells fill one after another | 420 ms + 40 ms stagger |
| **Filter chip** | An elastic press (0.94 scale), and the Volt fill wipes in from the left | 220 ms |
| **Favourite** | The star bursts into 6 Volt sparks | 500 ms |
| **Haptics** | `navigator.vibrate(8)` on snap, favourite and locate (where supported) | — |

**Easing tokens:** `--ease-out: cubic-bezier(.16,1,.3,1)`,
`--ease-spring: cubic-bezier(.34,1.56,.64,1)`, `--ease-in-out: cubic-bezier(.65,0,.35,1)`.

## 8. Voice and microcopy

The tone is short, warm and useful. It says "free" rather than "available."

* Empty filter result: "No free chargers match here. Try zooming out or
  clearing a filter."
* Location denied: "No worries. Search a place or drag the map to explore."
* Offline: "You're offline. Showing chargers from 4 min ago."
* Feed stale: "LTA's feed is catching up. Last update 12 min ago."

## 9. Accessibility

* State is never shown by color alone. The ring is backed by a text count
  ("3 of 4 free"), and busy pins use a different glyph pattern.
* Contrast is at least 4.5:1 for all text, and touch targets are at least
  44×44 px.
* Full keyboard support: `/` focuses search, `Esc` closes the detail, and the
  sheet works with the arrow keys.
* `prefers-reduced-motion` turns off breathing, ripples, morphs and
  `flyTo` (it jumps instead).
* `prefers-color-scheme` picks the light or dark theme, and the user can
  override it.

## 10. Architecture (why it's shaped this way)

```
 Phone (PWA, GitHub Pages)  ──►  Cloudflare Worker (holds LTA key)  ──►  LTA DataMall EVCBatch
        ▲   service worker                │ edge cache 60 s                 │ 2-step: link → S3 file
        └── offline: last good data ◄─────┘ stale-if-error 24 h             ▼
```

* The **LTA AccountKey lives only in Cloudflare** as the Worker secret
  `LTA_ACCOUNT_KEY`, the same name the WhereIsTheBus proxy uses. It never
  appears in this repo, in the frontend bundle or in GitHub Actions.
* The Worker fetches the EVCBatch file, which is about 2,800 locations and
  about 11,500 connectors. It cuts the file down to a compact JSON, caches it
  at the edge for 60 seconds (LTA refreshes it every 5 minutes) and keeps a
  last-good copy to serve when LTA is down.
