import "@fontsource-variable/inter";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "./styles.css";

import { loadChargers, loadDemo, searchPlaces, type DataMode, type Place } from "./api.ts";
import { CARET, CHEVRON_LEFT, CLOSE, NAV, PIN, PLUG_AC, PLUG_DC, SEARCH_EMPTY, SHARE, STAR, BOLT } from "./icons.ts";
import { ChargeMap, SG_CENTER, type Theme } from "./map.ts";
import {
  DEFAULT_FILTERS,
  availabilityA11y,
  availabilityText,
  distanceM,
  formatDistance,
  formatKw,
  groupPlugs,
  matchesFilters,
  operatorInfo,
  searchStations,
  tierLabel,
  timeAgo,
  toViewModels,
  bestKwhPrice,
  bestPrice,
  primaryOperator,
  clampPct,
  money,
  plugPrice,
  sanitizeDiscounts,
  type EffectivePrice,
  type Filters,
  type LngLat,
  type StationVM,
} from "./model.ts";
import { countTo, escapeHtml, haptic, reducedMotion, withViewTransition } from "./motion.ts";
import { boltsHtml, opBadge, pinHtml } from "./pin.ts";
import { BottomSheet } from "./sheet.ts";
import { registerPwa } from "./pwa.ts";
import { PROVIDER_APPS, detectPlatform, storeLinks } from "./provider-apps.ts";
import type { ChargersPayload } from "../shared/schema.ts";

const POLL_MS = 60_000;
const SORT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round"><path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/></svg>`;
const LIST_LIMIT = 50;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ── Persistent prefs ────────────────────────────────────────────────────

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`chargeit:${k}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(`chargeit:${k}`, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

// ── State ───────────────────────────────────────────────────────────────

/** Reads saved filters defensively: storage is shared with other pages on the same origin. */
function loadFilters(): Filters {
  const raw = store.get<Record<string, unknown>>("filters", {}) ?? {};
  const minKw = [0, 22, 50, 100].includes(Number(raw.minKw)) ? (Number(raw.minKw) as Filters["minKw"]) : 0;
  return {
    freeNow: raw.freeNow === true,
    dc: raw.dc === true,
    minKw,
    operators: Array.isArray(raw.operators) ? raw.operators.filter((o): o is string => typeof o === "string").slice(0, 30) : [],
    favourites: raw.favourites === true,
    maxPrice: typeof raw.maxPrice === "number" && raw.maxPrice >= 0 && raw.maxPrice <= 10 ? Math.round(raw.maxPrice * 100) / 100 : null,
  };
}

const state = {
  payload: null as ChargersPayload | null,
  mode: null as DataMode | null,
  all: [] as StationVM[],
  byId: new Map<string, StationVM>(),
  filtered: [] as StationVM[],
  filters: loadFilters(),
  highlightMine: store.get<unknown>("highlightMine", true) !== false,
  sort: (store.get<unknown>("sort", "near") === "cheap" ? "cheap" : "near") as "near" | "cheap",
  discounts: sanitizeDiscounts(store.get<unknown>("discounts", {})) as Record<string, number>,
  favs: new Set<string>((store.get<unknown[]>("favs", []) ?? []).filter((x): x is string => typeof x === "string")),
  user: null as LngLat | null,
  selected: null as string | null,
  loading: false,
  lastError: null as string | null,
};

const params = new URLSearchParams(location.search);
const wantDemo = params.has("demo");
if (params.has("free")) state.filters.freeNow = true; // PWA shortcut: "Free chargers near me"

// ── Theme ───────────────────────────────────────────────────────────────

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// ── Elements ────────────────────────────────────────────────────────────

const app = $("#app");
const sheetEl = $("#sheet");
const listEl = $<HTMLOListElement>("#list");
const listView = $("#view-list");
const detailView = $("#view-detail");
const liveBtn = $<HTMLButtonElement>("#live");
const searchInput = $<HTMLInputElement>("#search");
const searchResults = $<HTMLUListElement>("#search-results");
const searchClear = $<HTMLButtonElement>("#search-clear");
const filtersEl = $("#filters");
const locateBtn = $<HTMLButtonElement>("#locate");
const toastEl = $("#toast");

const sheet = new BottomSheet(sheetEl, () => [listEl, detailView]);
const cmap = new ChargeMap($("#map"), currentTheme(), {
  onSelect: (id) => openDetail(id, { fly: false }),
  onMove: () => {
    if (!state.selected) renderList();
  },
  onBackgroundClick: () => {
    searchResults.hidden = true;
    if (state.selected) closeDetail();
  },
});

sheet.onChange((snap) => {
  $(".fabs").classList.toggle("is-hidden", snap === "full");
});

// ── Splash ──────────────────────────────────────────────────────────────

function hideSplash(): void {
  const splash = $("#splash");
  const seen = sessionStorage.getItem("chargeit:splash");
  const delay = seen || reducedMotion() ? 0 : Math.max(0, 1250 - performance.now());
  setTimeout(() => {
    splash.classList.add("is-done");
    sessionStorage.setItem("chargeit:splash", "1");
    setTimeout(() => splash.remove(), 900);
    sheet.to(state.lastError && !state.payload ? "half" : "peek");
  }, delay);
}

// ── Toast ───────────────────────────────────────────────────────────────

let toastTimer = 0;
function toast(msg: string, action?: { label: string; run: () => void }, ms = 4200): void {
  toastEl.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => {
      toastEl.hidden = true;
      action.run();
    };
    toastEl.append(b);
  }
  toastEl.hidden = false;
  toastEl.style.animation = "none";
  void toastEl.offsetWidth;
  toastEl.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ── Data ────────────────────────────────────────────────────────────────

function applyPayload(payload: ChargersPayload, mode: DataMode): void {
  const first = !state.payload;
  state.payload = payload;
  state.mode = mode;
  state.all = toViewModels(payload);
  state.byId = new Map(state.all.map((s) => [s.id, s]));
  refilter();
  updateLive();
  if (state.selected) {
    if (state.byId.has(state.selected)) refreshDetail(state.selected);
    else closeDetail();
  }
  if (first) {
    const fromHash = readHash();
    if (fromHash && state.byId.has(fromHash)) openDetail(fromHash, { fly: true });
  }
}

async function refresh(manual = false): Promise<void> {
  if (state.loading) return;
  if (state.mode === "demo") {
    if (manual) toast("Showing a demo snapshot.", { label: "Try live", run: () => void goLive() });
    return;
  }
  state.loading = true;
  app.classList.add("is-refreshing");
  liveBtn.setAttribute("aria-busy", "true");
  try {
    const { payload, mode } = await loadChargers();
    state.lastError = null;
    applyPayload(payload, mode);
    if (manual) toast(mode === "offline" ? "You're offline. Showing the last chargers we saw." : "Updated with the latest from LTA.");
    if (mode === "stale" && manual) toast("LTA's feed is catching up — showing the latest we have.");
  } catch (err) {
    state.lastError = String(err);
    if (!state.payload) showLoadError();
    else if (manual) toast("Couldn't reach the live feed. We'll keep trying.");
    updateLive();
  } finally {
    state.loading = false;
    app.classList.remove("is-refreshing");
    liveBtn.removeAttribute("aria-busy");
  }
}

async function goLive(): Promise<void> {
  state.mode = null;
  const url = new URL(location.href);
  url.searchParams.delete("demo");
  history.replaceState(null, "", url);
  await refresh(true);
}

async function showDemo(): Promise<void> {
  app.classList.add("is-refreshing");
  try {
    const { payload, mode } = await loadDemo();
    applyPayload(payload, mode);
    toast("Demo snapshot — real LTA data, but not live.");
  } catch {
    toast("Couldn't load the demo snapshot.");
  } finally {
    app.classList.remove("is-refreshing");
  }
}

function showLoadError(): void {
  sheet.to("half");
  $("#list-sub").textContent = "Live feed unavailable";
  listEl.innerHTML = `<li class="empty">
      ${SEARCH_EMPTY}
      <div><strong>We can't reach the live charger feed right now.</strong></div>
      <div>Check your connection, or explore a recent snapshot.</div>
      <button type="button" class="btn btn--primary" data-act="retry">Try again</button>
      <button type="button" class="btn" data-act="demo">View demo snapshot</button>
    </li>`;
  listEl.querySelector<HTMLButtonElement>('[data-act="retry"]')!.onclick = () => void refresh(true);
  listEl.querySelector<HTMLButtonElement>('[data-act="demo"]')!.onclick = () => void showDemo();
}

let liveTimer = 0;
function updateLive(): void {
  const text = liveBtn.querySelector(".live__text")!;
  const p = state.payload;
  let s: string;
  let st: string;
  if (!p) {
    st = state.lastError ? "error" : "idle";
    s = state.lastError ? "Offline" : "Connecting…";
  } else {
    const ago = timeAgo(p.feedUpdated ?? p.fetchedAt);
    if (state.mode === "demo") {
      st = "demo";
      s = "Demo";
    } else if (state.mode === "offline" || state.lastError) {
      st = "error";
      s = `Offline · ${ago}`;
    } else if (state.mode === "stale") {
      st = "stale";
      s = `Delayed · ${ago}`;
    } else {
      st = "live";
      s = `Live · ${ago}`;
    }
  }
  liveBtn.dataset.state = st;
  text.textContent = s;
  liveBtn.title = p?.feedUpdated ? `LTA feed updated ${new Date(p.feedUpdated).toLocaleString()} — tap to refresh` : "Tap to refresh";
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(updateLive, 20_000);
}

// ── Filtering + list ────────────────────────────────────────────────────

function refilter(): void {
  state.filtered = state.all.filter((s) => matchesFilters(s, state.filters, state.favs, state.discounts));
  // Badge preference: providers the user filtered for, then the ones they have a discount with.
  const mineNames = Object.keys(state.discounts);
  const prefer = [...state.filters.operators, ...mineNames];
  const highlight = mineNames.length > 0 && state.highlightMine;
  cmap.setStations(state.filtered, {
    providerOf: (s) => primaryOperator(s, prefer),
    isMine: highlight ? (s) => s.sum.operators.some((o) => mineNames.includes(operatorInfo(o).name)) : null,
  });
  renderFilters();
  renderList();
}

function anchor(): LngLat {
  const c = cmap.center();
  // Prefer the user's position when it's on screen, otherwise the map centre.
  if (state.user && cmap.map.getBounds().contains([state.user.lng, state.user.lat])) return state.user;
  return c;
}

let listSig = "";
function renderList(force = false): void {
  if (!state.payload) {
    if (state.lastError) return; // keep the error card (with its retry/demo actions) in place
    listEl.innerHTML = Array.from({ length: 4 }, () => `<li class="skeleton"></li>`).join("");
    return;
  }
  const a = anchor();
  const visible = cmap.visibleIds();
  const inView = state.filtered.filter((s) => visible.has(s.id));
  const pool = inView.length ? inView : state.filtered;
  const cheap = state.sort === "cheap";
  const sorted = pool
    .map((s) => ({ s, d: distanceM(a, s), p: cheap ? bestKwhPrice(s, state.discounts) : null }))
    // Cheapest: by what the user pays per kWh (free first), unlisted last, ties by distance.
    .sort((x, y) => (cheap ? (x.p ?? Infinity) - (y.p ?? Infinity) || x.d - y.d : x.d - y.d))
    .slice(0, LIST_LIMIT);

  // Stats for what's on screen.
  const free = inView.reduce((n, s) => n + s.sum.free, 0);
  const busy = inView.reduce((n, s) => n + s.sum.busy, 0);
  const statsEl = $("#list-stats");
  if (!statsEl.children.length) {
    statsEl.innerHTML = `<div class="s-free"><b class="num" data-value="0">0</b><span>Free</span></div><div class="s-busy"><b class="num" data-value="0">0</b><span>In use</span></div>`;
  }
  countTo(statsEl.querySelector<HTMLElement>(".s-free b")!, free);
  countTo(statsEl.querySelector<HTMLElement>(".s-busy b")!, busy);

  const near = state.user && a === state.user;
  $("#list-title").textContent = state.filters.favourites ? "Favourites" : cheap ? (near ? "Cheapest near you" : "Cheapest here") : near ? "Near you" : "In this area";
  $("#list-sub").textContent = inView.length
    ? `${inView.length} site${inView.length === 1 ? "" : "s"} on the map${activeFilterCount() ? " · filtered" : ""}`
    : state.filtered.length
      ? "Nothing on screen — showing the closest"
      : "No matches";

  const sig = `${state.sort}|${sorted.map((x) => `${x.s.id}:${x.s.sum.free}:${x.s.sum.busy}`).join(",")}|${state.favs.size}|${JSON.stringify(state.discounts)}`;
  if (sig === listSig && !force) {
    // Same stations, same order: just refresh distances in place.
    sorted.forEach(({ s, d }) => {
      const el = listEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(s.id)}"] .card__dist`);
      if (el) el.textContent = formatDistance(d);
    });
    return;
  }
  const animate = sig.split("|")[0] !== listSig.split("|")[0];
  listSig = sig;

  if (!sorted.length) {
    listEl.innerHTML = `<li class="empty">${SEARCH_EMPTY}
      <div><strong>${state.filters.favourites ? "No favourites yet." : "No chargers match here."}</strong></div>
      <div>${state.filters.favourites ? "Tap ☆ on a charger to save it." : "Try zooming out or clearing a filter."}</div>
      ${activeFilterCount() ? `<button type="button" class="btn" data-act="clear">Clear filters</button>` : ""}</li>`;
    const b = listEl.querySelector<HTMLButtonElement>('[data-act="clear"]');
    if (b) b.onclick = () => setFilters({ ...DEFAULT_FILTERS });
    return;
  }

  listEl.innerHTML = sorted
    .map(({ s, d, p }, i) => {
      // Lead with the provider the user filtered for, if any.
      const ops = s.sum.operators.map(operatorInfo);
      const op = ops.find((o) => state.filters.operators.includes(o.name)) ?? ops[0] ?? operatorInfo("");
      const more = s.sum.operators.length > 1 ? ` +${s.sum.operators.length - 1}` : "";
      const bp = bestPrice(s, state.discounts);
      const price = !bp
        ? ""
        : bp.price === 0
          ? `<span>Free</span>`
          : bp.pct
            ? `<span class="price-deal">from <b>${money(bp.price)}</b> <s>${money(bp.original)}</s></span>`
            : `<span>from ${money(bp.price)}</span>`;
      return `<li><button type="button" class="card" data-id="${escapeHtml(s.id)}" style="--delay:${animate ? Math.min(i, 10) * 35 : 0}ms${animate ? "" : ";animation:none"}"
          aria-label="${escapeHtml(`${s.name}, ${availabilityA11y(s.sum)}, up to ${formatKw(s.sum.maxKw)}, ${formatDistance(d)} away`)}">
        ${pinHtml(s.sum)}
        <span class="card__body">
          <p class="card__name" style="view-transition-name:${state.selected ? "none" : `n-${cssId(s.id)}`}">${state.favs.has(s.id) ? "★ " : ""}${escapeHtml(s.name)}</p>
          <span class="card__meta">
            <span class="avail avail--${s.sum.state}">${availabilityText(s.sum)}</span>
            <span>${formatKw(s.sum.maxKw)}${s.sum.hasDC ? " DC" : ""}</span>
            <span class="op">${opBadge(op)}${escapeHtml(op.name)}${more}</span>
            ${cheap ? "" : price /* in Cheapest mode the price is shown large on the right */}
          </span>
        </span>
        <span class="card__side">
          ${
            cheap
              ? `<span class="card__price${p === 0 ? " is-free" : p === null ? " is-na" : ""}">${p === null ? "No price" : p === 0 ? "Free" : `${money(p)}<small>/kWh</small>`}</span><span class="card__dist card__dist--sub">${formatDistance(d)}</span>`
              : `<span class="card__dist">${formatDistance(d)}</span>${boltsHtml(s.sum.tier)}`
          }
        </span>
      </button></li>`;
    })
    .join("");
  if (state.filtered.length > LIST_LIMIT) {
    listEl.insertAdjacentHTML("beforeend", `<li class="list-foot">Showing the ${LIST_LIMIT} closest. Move the map to see more.</li>`);
  }
}

listEl.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".card");
  if (card?.dataset.id) openDetail(card.dataset.id, { fly: true });
});

function cssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── Detail ──────────────────────────────────────────────────────────────

function openDetail(id: string, opts: { fly: boolean }): void {
  const st = state.byId.get(id);
  if (!st) return;
  haptic(8);
  const wasOpen = !!state.selected;
  state.selected = id;
  cmap.select(id);
  writeHash(id);
  withViewTransition(() => {
    renderDetail(id, !wasOpen);
    if (!wasOpen) {
      listView.classList.remove("is-entering");
      listView.hidden = true;
      detailView.hidden = false;
    }
    detailView.scrollTop = 0;
  });
  if (sheet.snap === "peek") sheet.to("half");
  const pad = sheet.heightFor("half") + 20;
  if (opts.fly || !cmap.map.getBounds().contains([st.lng, st.lat])) cmap.flyToStation(st, pad);
  else cmap.flyTo([st.lng, st.lat], Math.max(cmap.map.getZoom(), 15), pad);
}

function closeDetail(): void {
  if (!state.selected) return;
  const id = state.selected;
  state.selected = null;
  cmap.select(null);
  writeHash(null);
  void withViewTransition(() => {
    detailView.hidden = true;
    detailView.dataset.sig = "";
    listView.hidden = false;
    listView.classList.remove("is-entering");
    void listView.offsetWidth;
    listView.classList.add("is-entering");
    renderList(true);
  }).then(() => {
    // Return focus to the station's card for keyboard users.
    listEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  });
}

const platform = detectPlatform();

/** Provider rows for the detail view: logo, name, and the app you charge with (when known). */
function providersHtml(ops: ReturnType<typeof operatorInfo>[]): string {
  if (!ops.length) return "";
  return `<ul class="providers">${ops
    .map((o) => {
      const app = o.slug ? PROVIDER_APPS[o.slug] : undefined;
      const links = app ? storeLinks(app, platform) : [];
      return `<li class="provider${app ? " has-app" : ""}">
        ${opBadge(o, "m")}
        <span class="provider__text"><b>${escapeHtml(o.name)}</b>${
          !app
            ? ""
            : app.name
              ? `<small>Charge with <strong>${escapeHtml(app.name)}</strong>${app.note ? ` · ${escapeHtml(app.note)}` : ""}</small>`
              : `<small>${escapeHtml(app.note ?? "")}</small>`
        }</span>
        ${links.map((l) => `<a class="provider__get" href="${escapeHtml(l.url)}" target="_blank" rel="noopener" aria-label="Get ${escapeHtml(app?.name ?? "the app")} on ${l.label}">${links.length > 1 ? escapeHtml(l.label) : "Get app"}</a>`).join("")}
      </li>`;
    })
    .join("")}</ul>`;
}

function priceTile(bp: EffectivePrice | null, attrs: string): string {
  if (!bp) return `<div class="tile" ${attrs}><b class="num">–</b><span>Price</span></div>`;
  if (bp.price === 0) return `<div class="tile" ${attrs}><b class="num avail--free">Free</b><span>Price</span></div>`;
  if (!bp.pct) return `<div class="tile" ${attrs}><b class="num">${money(bp.price)}</b><span>From /${escapeHtml(bp.unit)}</span></div>`;
  return `<div class="tile tile--deal" ${attrs}><b class="num">${money(bp.price)}</b><span><s>${money(bp.original)}</s> <em class="deal">−${bp.pct}%</em></span></div>`;
}

function groupPriceHtml(ep: EffectivePrice | null): string {
  if (!ep) return `<span class="group__price is-na">Price not listed</span>`;
  if (ep.price === 0) return `<span class="group__price is-free">Free</span>`;
  if (!ep.pct) return `<span class="group__price">${money(ep.price)}<small>/${escapeHtml(ep.unit)}</small></span>`;
  return `<span class="group__price is-deal">${money(ep.price)}<small>/${escapeHtml(ep.unit)}</small><small class="was"><s>${money(ep.original)}</s> <em class="deal">−${ep.pct}%</em></small></span>`;
}

function detailSig(st: StationVM): string {
  return JSON.stringify(st.points) + (state.favs.has(st.id) ? "*" : "") + JSON.stringify(state.discounts);
}

/** Re-renders an open detail only when its data changed, preserving the nav menu and focus. */
function refreshDetail(id: string): void {
  const st = state.byId.get(id);
  if (!st || detailView.dataset.sig === detailSig(st)) return;
  const menuOpen = !detailView.querySelector<HTMLElement>(".nav-menu")?.hidden;
  const focusAct = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#view-detail [data-act]")?.dataset.act;
  const scroll = detailView.scrollTop;
  renderDetail(id, false);
  detailView.scrollTop = scroll;
  if (menuOpen) toggleNavMenu(st);
  if (focusAct) detailView.querySelector<HTMLElement>(`[data-act="${focusAct}"]`)?.focus({ preventScroll: true });
}

function renderDetail(id: string, animate: boolean): void {
  const st = state.byId.get(id);
  if (!st) return;
  const s = st.sum;
  const groups = groupPlugs(st);
  const d = state.user ? formatDistance(distanceM(state.user, st)) : null;
  const ops = s.operators.map(operatorInfo);
  const fav = state.favs.has(id);
  const updated = state.payload ? timeAgo(state.payload.feedUpdated ?? state.payload.fetchedAt) : "";
  const anim = (i: number) => (animate ? `style="--delay:${i * 45}ms"` : `style="animation:none"`);
  detailView.dataset.sig = detailSig(st);

  detailView.innerHTML = `
    <button type="button" class="back" data-act="back">${CHEVRON_LEFT}<span>Nearby</span></button>
    <div class="detail__top">
      ${pinHtml(s)}
      <div class="detail__title">
        <h2 style="view-transition-name:n-${cssId(id)}">${escapeHtml(st.name)}</h2>
        <p>${escapeHtml(st.address || st.postal)}${d ? ` · ${d} away` : ""}</p>
      </div>
      <div class="detail__actions-top">
        <button type="button" class="icon-btn fav" data-act="fav" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} favourites">${STAR}</button>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">${CLOSE}</button>
      </div>
    </div>
    <div class="detail__summary">
      <div class="tile" ${anim(0)}><b class="num avail--${s.state}">${s.state === "offline" ? "–" : `${s.free}<small style="font-size:13px;color:var(--muted)">/${s.free + s.busy}</small>`}</b><span>Free now</span></div>
      <div class="tile" ${anim(1)}><b class="num">${formatKw(s.maxKw).replace(" kW", "")}<small style="font-size:13px;color:var(--muted)"> kW</small></b><span>${tierLabel(s.tier)} ${boltsHtml(s.tier)}</span></div>
      ${priceTile(bestPrice(st, state.discounts), anim(2))}
    </div>
    <div class="detail__cta">
      <button type="button" class="btn btn--primary" data-act="nav">${NAV}Directions</button>
      <button type="button" class="btn" data-act="share" aria-label="Share">${SHARE}</button>
    </div>
    <div class="nav-menu" hidden></div>
    <h3 class="section-h">Chargers</h3>
    ${providersHtml(ops)}
    ${groups
      .map((g, gi) => {
        const op = operatorInfo(g.operator);
        const ep = plugPrice(g.plug, g.operator, state.discounts);
        const gFree = g.connectors.filter((c) => c.s === 1).length;
        return `<section class="group" ${anim(gi + 3)}>
          <div class="group__head">
            <span class="group__plug" aria-hidden="true">${g.current === "DC" ? PLUG_DC : PLUG_AC}</span>
            <span class="group__title">
              <b>${escapeHtml(g.label)} · ${formatKw(g.kw)}</b>
              <small>${escapeHtml(g.current || "—")} · ${boltsHtml(Math.min(3, Math.max(0, g.kw === null ? 0 : g.kw < 11 ? 1 : g.kw < 50 ? 2 : 3)))} · ${gFree}/${g.connectors.filter((c) => c.s !== null).length} free${ops.length > 1 ? ` · <span class="op">${opBadge(op)}${escapeHtml(op.name)}</span>` : ""}</small>
            </span>
            ${groupPriceHtml(ep)}
          </div>
          <div class="cells">
            ${g.connectors
              .map((c, ci) => {
                const cls = c.s === 1 ? "free" : c.s === 0 ? "busy" : "offline";
                const lbl = c.s === 1 ? "Free" : c.s === 0 ? "In use" : "Offline";
                return `<div class="cell cell--${cls}" style="--delay:${animate ? 200 + (gi * 4 + ci) * 40 : 0}ms" title="${escapeHtml(c.id)}" aria-label="${escapeHtml(`${lbl}${c.position ? `, lot ${c.position}` : ""}`)}">
                  <b>${lbl}</b><span>${escapeHtml(c.position || c.id.slice(-6) || "—")}</span></div>`;
              })
              .join("")}
          </div>
        </section>`;
      })
      .join("")}
    <p class="detail__foot">
      ${st.points[0]?.hours ? `Hours: ${escapeHtml(st.points[0].hours)}<br/>` : ""}
      Availability ${state.mode === "demo" ? "from a demo snapshot" : `updated ${escapeHtml(updated)}`}. Prices are set by the provider and may change; check the provider's app before charging.
    </p>`;
}

detailView.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!btn || !state.selected) return;
  const st = state.byId.get(state.selected);
  if (!st) return;
  switch (btn.dataset.act) {
    case "back":
    case "close":
      closeDetail();
      break;
    case "fav":
      toggleFav(st.id, btn);
      break;
    case "nav":
      toggleNavMenu(st);
      break;
    case "share":
      void share(st);
      break;
  }
});

function toggleFav(id: string, btn: HTMLElement): void {
  const on = !state.favs.has(id);
  if (on) state.favs.add(id);
  else state.favs.delete(id);
  store.set("favs", [...state.favs]);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", `${on ? "Remove from" : "Add to"} favourites`);
  if (on && !reducedMotion()) {
    btn.classList.remove("is-burst");
    void btn.offsetWidth;
    btn.classList.add("is-burst");
  }
  haptic(on ? 12 : 6);
  if (state.filters.favourites) refilter();
  listSig = "";
}

function toggleNavMenu(st: StationVM): void {
  const menu = detailView.querySelector<HTMLElement>(".nav-menu")!;
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  const dest = `${st.lat},${st.lng}`;
  const links = [
    ["Google Maps", `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`],
    ["Apple Maps", `https://maps.apple.com/?daddr=${dest}&dirflg=d`],
    ["Waze", `https://waze.com/ul?ll=${dest}&navigate=yes`],
  ];
  menu.innerHTML = links.map(([n, u]) => `<a class="btn" href="${u}" target="_blank" rel="noopener">${n}</a>`).join("");
  menu.hidden = false;
}

async function share(st: StationVM): Promise<void> {
  const url = new URL(location.href);
  url.search = "";
  url.hash = `s=${encodeURIComponent(st.id)}`;
  const text = `${st.name} — ${availabilityText(st.sum)}, up to ${formatKw(st.sum.maxKw)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "ChargeIt", text, url: url.toString() });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast("Link copied.");
  } catch {
    /* user cancelled */
  }
}

// ── Deep links ──────────────────────────────────────────────────────────

function readHash(): string | null {
  const m = location.hash.match(/s=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed link — ignore rather than break boot
  }
}
window.addEventListener("hashchange", () => {
  const id = readHash();
  if (id && id !== state.selected && state.byId.has(id)) openDetail(id, { fly: true });
  else if (!id && state.selected) closeDetail();
});
function writeHash(id: string | null): void {
  const url = new URL(location.href);
  url.hash = id ? `s=${encodeURIComponent(id)}` : "";
  history.replaceState(null, "", url.hash ? url : url.pathname + url.search);
}

// ── Filters ─────────────────────────────────────────────────────────────

function activeFilterCount(): number {
  const f = state.filters;
  return Number(f.freeNow) + Number(f.dc) + Number(f.minKw > 0) + Number(f.operators.length > 0) + Number(f.favourites) + Number(f.maxPrice !== null);
}

function setFilters(f: Filters): void {
  state.filters = f;
  store.set("filters", f);
  haptic(6);
  closeMenus();
  refilter();
}

function renderFilters(): void {
  const f = state.filters;
  const speedLabel = f.minKw ? `≥ ${f.minKw} kW` : "Any speed";
  const opLabel = f.operators.length === 1 ? f.operators[0] : f.operators.length ? `${f.operators.length} providers` : "Provider";
  const chips = [
    `<button type="button" class="chip" data-f="freeNow" aria-pressed="${f.freeNow}"><span>Free now</span></button>`,
    `<button type="button" class="chip" data-f="dc" aria-pressed="${f.dc}">${BOLT}<span>DC fast</span></button>`,
    `<button type="button" class="chip" data-f="speed" aria-pressed="${f.minKw > 0}" aria-haspopup="true"><span>${speedLabel}</span>${CARET}</button>`,
    `<button type="button" class="chip" data-f="price" aria-pressed="${f.maxPrice !== null}" aria-haspopup="dialog"><span>${f.maxPrice === null ? "Any price" : f.maxPrice === 0 ? "Free only" : `≤ ${money(f.maxPrice)}`}</span>${CARET}</button>`,
    `<button type="button" class="chip chip--sort" data-f="sort" aria-pressed="${state.sort === "cheap"}" aria-label="Sort list: ${state.sort === "cheap" ? "cheapest first" : "nearest first"}">${SORT_ICON}<span>${state.sort === "cheap" ? "Cheapest" : "Nearest"}</span></button>`,
    `<button type="button" class="chip" data-f="ops" aria-pressed="${f.operators.length > 0}" aria-haspopup="true"><span>${escapeHtml(opLabel)}</span>${CARET}</button>`,
    `<button type="button" class="chip" data-f="favourites" aria-pressed="${f.favourites}">${STAR.replace("<svg", '<svg style="fill:currentColor"')}<span>Saved</span></button>`,
  ];
  if (activeFilterCount() > 1) chips.push(`<button type="button" class="chip" data-f="clear" aria-pressed="false"><span>Clear</span></button>`);
  const html = chips.join("");
  if (filtersEl.dataset.html !== html) {
    filtersEl.innerHTML = html;
    filtersEl.dataset.html = html;
  }
}

filtersEl.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
  if (!chip) return;
  const f = { ...state.filters };
  switch (chip.dataset.f) {
    case "freeNow":
      setFilters({ ...f, freeNow: !f.freeNow });
      break;
    case "dc":
      setFilters({ ...f, dc: !f.dc });
      break;
    case "favourites":
      setFilters({ ...f, favourites: !f.favourites });
      break;
    case "clear":
      setFilters({ ...DEFAULT_FILTERS });
      break;
    case "speed":
      openMenu(chip, [0, 22, 50, 100].map((kw) => ({ label: kw ? `≥ ${kw} kW${kw >= 50 ? " (DC rapid)" : ""}` : "Any speed", checked: f.minKw === kw, value: String(kw) })), "radio", (vals) =>
        setFilters({ ...state.filters, minKw: Number(vals[0]) as Filters["minKw"] }),
      );
      break;
    case "price":
      openPriceMenu(chip);
      break;
    case "sort":
      state.sort = state.sort === "cheap" ? "near" : "cheap";
      store.set("sort", state.sort);
      haptic(6);
      closeMenus();
      renderFilters();
      renderList(true);
      listEl.scrollTop = 0;
      break;
    case "ops": {
      const counts = new Map<string, number>();
      for (const s of state.all) for (const o of s.sum.operators) counts.set(operatorInfo(o).name, (counts.get(operatorInfo(o).name) ?? 0) + 1);
      const byName = new Map(state.all.flatMap((s) => s.sum.operators.map((o) => [operatorInfo(o).name, operatorInfo(o)] as const)));
      const items = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => ({ label: name, count: n, checked: f.operators.includes(name), value: name, icon: byName.get(name) ? opBadge(byName.get(name)!) : "" }));
      openMenu(chip, items, "checkbox", (vals) => setFilters({ ...state.filters, operators: vals }), false);
      break;
    }
  }
});

// ── Price slider ────────────────────────────────────────────────────────

/** Slider domain: $0 up to the dearest listed price (rounded up to 5¢), plus one "Any price" stop. */
function priceDomain(): { max: number; any: number } {
  let hi = 0;
  for (const s of state.all) {
    const p = bestKwhPrice(s, state.discounts);
    if (p !== null && p > hi) hi = p;
  }
  const max = Math.max(0.5, Math.ceil(hi * 20) / 20);
  // A clear gap before "Any" so the last price tick and the Any stop don't collide.
  return { max, any: Math.round((max + 0.1) * 100) / 100 };
}

function openPriceMenu(anchorEl: HTMLElement): void {
  if (menuEl) {
    const same = menuAnchor === "price";
    closeMenus();
    if (same) return;
  }
  menuAnchor = "price";
  const { max, any } = priceDomain();
  const m = document.createElement("div");
  m.className = "chip-menu price-menu";
  m.setAttribute("role", "dialog");
  m.setAttribute("aria-label", "Maximum price");
  const start = state.filters.maxPrice ?? any;
  m.innerHTML = `
    <div class="price-menu__head"><b class="num" data-out></b><span data-count></span></div>
    <input type="range" min="0" max="${any}" step="0.01" value="${start}" aria-label="Maximum price per kWh"/>
    <div class="price-menu__scale" aria-hidden="true">${[0, Math.round((max / 3) * 20) / 20, Math.round(((2 * max) / 3) * 20) / 20]
      .map((v) => `<span style="left:${((v / any) * 100).toFixed(2)}%">${v === 0 ? "$0" : money(v)}</span>`)
      .join("")}<span style="left:100%">Any</span></div>
    <p class="price-menu__hint">Uses the cheapest price at each site${Object.keys(state.discounts).length ? ", after your discounts" : ""}. Sites without a listed price are hidden unless set to Any.</p>
    <div class="price-menu__actions"><button type="button" class="btn" data-any>Any price</button><button type="button" class="btn btn--primary" data-done>Done</button></div>`;
  document.body.append(m);
  const r = anchorEl.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.max(14, Math.min(r.left, window.innerWidth - m.offsetWidth - 14))}px`;
  const input = m.querySelector<HTMLInputElement>("input")!;
  const out = m.querySelector<HTMLElement>("[data-out]")!;
  const count = m.querySelector<HTMLElement>("[data-count]")!;

  let raf = 0;
  const apply = (v: number) => {
    const isAny = v >= any - 0.001;
    const next = isAny ? null : Math.round(v * 100) / 100;
    out.textContent = next === null ? "Any price" : next === 0 ? "Free only" : `Up to ${money(next)}/kWh`;
    input.setAttribute("aria-valuetext", next === null ? "Any price, including unlisted" : `Up to ${money(next)} per kWh`);
    input.style.setProperty("--fill", `${(v / any) * 100}%`);
    if (next === state.filters.maxPrice) return;
    state.filters = { ...state.filters, maxPrice: next };
    store.set("filters", state.filters);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      refilter();
      count.textContent = `${state.filtered.length.toLocaleString()} site${state.filtered.length === 1 ? "" : "s"}`;
    });
  };
  count.textContent = `${state.filtered.length.toLocaleString()} sites`;
  apply(start);
  input.addEventListener("input", () => apply(Number(input.value)));
  input.addEventListener("change", () => haptic(6));
  m.querySelector("[data-any]")!.addEventListener("click", () => {
    input.value = String(any);
    apply(any);
  });
  m.querySelector("[data-done]")!.addEventListener("click", closeMenus);
  menuEl = m;
  input.focus();
}

let menuEl: HTMLElement | null = null;
let menuAnchor: string | null = null;
function closeMenus(): void {
  menuEl?.remove();
  menuEl = null;
  menuAnchor = null;
}
function openMenu(
  anchorEl: HTMLElement,
  items: Array<{ label: string; value: string; checked: boolean; count?: number; icon?: string }>,
  kind: "radio" | "checkbox",
  onApply: (vals: string[]) => void,
  closeOnPick = true,
): void {
  if (menuEl) {
    const same = menuAnchor === anchorEl.dataset.f;
    closeMenus();
    if (same) return; // tapping the same chip toggles its menu closed
  }
  menuAnchor = anchorEl.dataset.f ?? null;
  const m = document.createElement("div");
  m.className = "chip-menu";
  m.setAttribute("role", "dialog");
  m.innerHTML = items
    .map(
      (it) =>
        `<label><input type="${kind}" name="m" value="${escapeHtml(it.value)}" aria-label="${escapeHtml(it.label)}${it.count !== undefined ? `, ${it.count} sites` : ""}" ${it.checked ? "checked" : ""}/>${it.icon ?? ""}<span>${escapeHtml(it.label)}</span>${it.count !== undefined ? `<span class="count">${it.count}</span>` : ""}</label>`,
    )
    .join("");
  document.body.append(m);
  const r = anchorEl.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.min(r.left, window.innerWidth - m.offsetWidth - 14)}px`;
  m.addEventListener("change", () => {
    const vals = [...m.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
    if (closeOnPick) onApply(vals);
    else {
      state.filters = { ...state.filters };
      onApply(vals);
      // Re-open in place so multi-select stays usable.
      requestAnimationFrame(() => {
        const chip = filtersEl.querySelector<HTMLElement>('[data-f="ops"]');
        if (chip) {
          menuEl?.remove();
          menuEl = null;
          menuAnchor = null;
          openMenu(chip, items.map((i) => ({ ...i, checked: vals.includes(i.value) })), kind, onApply, false);
        }
      });
    }
  });
  menuEl = m;
  m.querySelector<HTMLInputElement>("input")?.focus();
}
document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node) && !(e.target as HTMLElement).closest(".chip")) closeMenus();
});
document.addEventListener("keydown", (e) => {
  // The global Esc handler ignores keys typed into inputs, so the slider closes its own popover.
  if (e.key === "Escape" && menuEl?.contains(e.target as Node)) closeMenus();
});

// ── Search ──────────────────────────────────────────────────────────────

let searchSeq = 0;
let placeCtl: AbortController | null = null;
let activeIdx = -1;
let searchTimer = 0;

function runSearch(): void {
  const q = searchInput.value.trim();
  searchClear.hidden = !q;
  if (!q) {
    hideResults();
    return;
  }
  const seq = ++searchSeq;
  const stations = searchStations(state.all, q, 5);
  renderResults(stations, null, q);
  clearTimeout(searchTimer);
  if (q.length >= 2) {
    searchTimer = window.setTimeout(async () => {
      placeCtl?.abort();
      placeCtl = new AbortController();
      try {
        const places = await searchPlaces(q, placeCtl.signal);
        if (seq === searchSeq) renderResults(stations, places, q);
      } catch {
        /* network / aborted */
      }
    }, 220);
  }
}

function renderResults(stations: StationVM[], places: Place[] | null, q: string): void {
  const items: string[] = [];
  if (places?.length) {
    items.push(`<li class="search__group" role="presentation">Places</li>`);
    places.forEach((p, i) =>
      items.push(
        `<li class="search__item" role="option" data-place="${i}"><span class="ico">${PIN}</span><div><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.address)}</small></div></li>`,
      ),
    );
  }
  if (stations.length) {
    items.push(`<li class="search__group" role="presentation">Chargers</li>`);
    stations.forEach((s) =>
      items.push(
        `<li class="search__item" role="option" data-id="${escapeHtml(s.id)}"><span class="ico" style="color:var(--volt)">${BOLT}</span><div><b>${escapeHtml(s.name)}</b><small><span class="avail--${s.sum.state}">${availabilityText(s.sum)}</span> · ${formatKw(s.sum.maxKw)} · <span class="op">${opBadge(operatorInfo(s.sum.operators[0] ?? ""))}${escapeHtml(operatorInfo(s.sum.operators[0] ?? "").name)}</span></small></div></li>`,
      ),
    );
  }
  if (!items.length) items.push(`<li class="search__empty">${places === null ? "Searching…" : `No results for “${escapeHtml(q)}”`}</li>`);
  searchResults.innerHTML = items.join("");
  (searchResults as HTMLElement & { _places?: Place[] })._places = places ?? [];
  searchResults.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  activeIdx = -1;
}

function hideResults(): void {
  searchResults.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
}

function pickResult(li: HTMLElement): void {
  hideResults();
  searchInput.blur();
  if (li.dataset.id) {
    openDetail(li.dataset.id, { fly: true });
  } else if (li.dataset.place) {
    const p = (searchResults as HTMLElement & { _places?: Place[] })._places?.[Number(li.dataset.place)];
    if (!p) return;
    if (state.selected) closeDetail();
    sheet.to("half");
    cmap.flyTo([p.lng, p.lat], 15, sheet.heightFor("half") + 20, 30);
    toast(`Chargers near ${p.name}`);
  }
}

searchInput.addEventListener("input", runSearch);
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim()) runSearch();
});
searchInput.addEventListener("keydown", (e) => {
  const opts = [...searchResults.querySelectorAll<HTMLElement>(".search__item")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!opts.length) return;
    activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === activeIdx)));
    opts[activeIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    const pick = opts[activeIdx] ?? opts[0];
    if (pick) pickResult(pick);
  } else if (e.key === "Escape") {
    hideResults();
    searchInput.blur();
  }
});
searchResults.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".search__item");
  if (li) pickResult(li);
});
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.hidden = true;
  hideResults();
  searchInput.focus();
});

// ── Location ────────────────────────────────────────────────────────────

let watchId: number | null = null;
function stopWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function locate(fly: boolean, silent = false): void {
  if (!("geolocation" in navigator)) {
    if (!silent) toast("Location isn't available on this device. Search a place instead.");
    return;
  }
  locateBtn.classList.add("is-seeking");
  haptic(8);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateBtn.classList.remove("is-seeking");
      locateBtn.classList.add("is-active");
      const here = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      store.set("located", true);
      const inSg = here.lat > 1.1 && here.lat < 1.5 && here.lng > 103.55 && here.lng < 104.15;
      if (!inSg) {
        state.user = null; // distances from overseas aren't useful
        locateBtn.classList.remove("is-active");
        if (!silent) toast("You seem to be outside Singapore — showing the whole island.");
        return;
      }
      state.user = here;
      cmap.showUser(state.user, true);
      if (fly) cmap.flyTo([state.user.lng, state.user.lat], 15, sheet.settledHeight + 20, 40);
      if (watchId === null) {
        watchId = navigator.geolocation.watchPosition(
          (p) => {
            state.user = { lng: p.coords.longitude, lat: p.coords.latitude };
            cmap.showUser(state.user, false);
          },
          () => undefined,
          { enableHighAccuracy: true, maximumAge: 15_000 },
        );
      }
    },
    (err) => {
      locateBtn.classList.remove("is-seeking");
      if (err.code === err.PERMISSION_DENIED) {
        store.set("located", false);
        if (!silent) toast("No worries — search a place or drag the map to explore.");
      } else if (!silent) toast("Couldn't find your location. Try again in a moment.");
    },
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
  );
}
locateBtn.addEventListener("click", () => {
  locateBtn.querySelector("svg")?.animate?.([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: reducedMotion() ? 0 : 600, easing: "cubic-bezier(.16,1,.3,1)" });
  locate(true);
});

// ── Theme ───────────────────────────────────────────────────────────────

type ThemeChoice = "auto" | Theme;

function themeChoice(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "auto";
}

function setTheme(choice: ThemeChoice): void {
  const apply = () => {
    if (choice === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    try {
      if (choice === "auto") localStorage.removeItem("chargeit:theme");
      else localStorage.setItem("chargeit:theme", choice);
    } catch {
      /* private mode */
    }
  };
  void withViewTransition(apply);
  void cmap.applyTheme(currentTheme());
  haptic(6);
  renderThemeChoice(choice); // the DOM update above may still be pending inside a view transition
}

function renderThemeChoice(c: ThemeChoice = themeChoice()): void {
  settingsEl.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === c)));
}

// ── Settings: corporate / fleet discounts ───────────────────────────────

const settingsEl = $<HTMLDialogElement>("#settings");
const discountList = $<HTMLUListElement>("#discount-list");
const QUICK_PCTS = [5, 10, 15, 20, 25, 30];
let openDiscount: string | null = null;

/** Providers in today's data (busiest first), plus any the user has a discount for. */
function providerChoices(): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of state.all) for (const o of s.sum.operators) counts.set(operatorInfo(o).name, (counts.get(operatorInfo(o).name) ?? 0) + 1);
  for (const name of Object.keys(state.discounts)) if (!counts.has(name)) counts.set(name, 0);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Operator info by display name (falls back to a synthetic entry for names no longer in the feed). */
function opByName(name: string) {
  for (const s of state.all) for (const o of s.sum.operators) if (operatorInfo(o).name === name) return operatorInfo(o);
  return operatorInfo(name);
}

function renderDiscounts(): void {
  const items = providerChoices();
  if (!items.length) {
    discountList.innerHTML = `<li class="settings__hint">Providers appear here once charger data has loaded.</li>`;
    return;
  }
  const active = items.filter((i) => state.discounts[i.name]);
  const rest = items.filter((i) => !state.discounts[i.name]);
  discountList.innerHTML = [...active, ...rest]
    .map(({ name, count }) => {
      const pct = state.discounts[name] ?? 0;
      const open = openDiscount === name;
      const id = `d-${cssId(name)}`;
      return `<li class="disc${pct ? " is-on" : ""}${open ? " is-open" : ""}" data-name="${escapeHtml(name)}">
        <button type="button" class="disc__row" aria-expanded="${open}" aria-controls="${id}">
          ${opBadge(opByName(name), "m")}
          <span class="disc__name"><b>${escapeHtml(name)}</b><small>${count ? `${count} site${count === 1 ? "" : "s"}` : "Not in today's data"}</small></span>
          <span class="disc__val">${pct ? `−${pct}%` : "Add"}</span>
        </button>
        <div class="disc__edit" id="${id}" ${open ? "" : "hidden"}>
          <div class="disc__chips" role="group" aria-label="Quick discount for ${escapeHtml(name)}">
            ${QUICK_PCTS.map((p) => `<button type="button" class="chip" data-pct="${p}" aria-pressed="${pct === p}">${p}%</button>`).join("")}
          </div>
          <div class="disc__custom">
            <label>Custom <input type="number" inputmode="decimal" min="0" max="100" step="0.5" placeholder="0" value="${pct || ""}" aria-label="Percent off for ${escapeHtml(name)}"/> % off</label>
            ${pct ? `<button type="button" class="btn" data-clear>Remove</button>` : ""}
          </div>
        </div>
      </li>`;
    })
    .join("");
}

function setDiscount(name: string, pct: number): void {
  const next = { ...state.discounts };
  const v = clampPct(pct);
  if (v > 0) next[name] = v;
  else delete next[name];
  state.discounts = next;
  store.set("discounts", next);
  haptic(8);
  $("#settings-dot").hidden = !Object.keys(next).length;
  // Re-price everything on screen and re-highlight the map.
  refilter();
  renderList(true);
  if (state.selected) refreshDetail(state.selected);
}

discountList.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const li = t.closest<HTMLElement>(".disc");
  const name = li?.dataset.name;
  if (!li || !name) return;
  if (t.closest(".disc__row")) {
    openDiscount = openDiscount === name ? null : name;
    renderDiscounts();
    discountList.querySelector<HTMLElement>(`.disc.is-open input`)?.focus({ preventScroll: true });
    return;
  }
  const chip = t.closest<HTMLElement>("[data-pct]");
  if (chip) {
    const p = Number(chip.dataset.pct);
    setDiscount(name, state.discounts[name] === p ? 0 : p);
    renderDiscounts();
    return;
  }
  if (t.closest("[data-clear]")) {
    setDiscount(name, 0);
    openDiscount = null;
    renderDiscounts();
  }
});
discountList.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const name = input.closest<HTMLElement>(".disc")?.dataset.name;
  if (!name || input.type !== "number") return;
  setDiscount(name, clampPct(input.value));
  renderDiscounts();
  discountList.querySelector<HTMLElement>(`.disc.is-open input`)?.focus({ preventScroll: true });
});

const highlightToggle = $<HTMLInputElement>("#highlight-mine");
highlightToggle.addEventListener("change", () => {
  state.highlightMine = highlightToggle.checked;
  store.set("highlightMine", state.highlightMine);
  haptic(6);
  refilter();
});

function openSettings(): void {
  closeMenus();
  highlightToggle.checked = state.highlightMine;
  renderDiscounts();
  renderThemeChoice();
  settingsEl.showModal();
  settingsEl.classList.remove("is-closing");
  haptic(6);
}
function closeSettings(): void {
  if (!settingsEl.open) return;
  if (reducedMotion()) {
    settingsEl.close();
    return;
  }
  settingsEl.classList.add("is-closing");
  setTimeout(() => {
    settingsEl.close();
    settingsEl.classList.remove("is-closing");
  }, 220);
}
$("#settings-btn").addEventListener("click", openSettings);
settingsEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t === settingsEl || t.closest("[data-close]")) closeSettings(); // backdrop or ✕
  const choice = t.closest<HTMLElement>("[data-theme-choice]")?.dataset.themeChoice as ThemeChoice | undefined;
  if (choice) setTheme(choice);
});
settingsEl.addEventListener("cancel", (e) => {
  e.preventDefault(); // Esc: animate out instead of snapping
  closeSettings();
});
$("#settings-dot").hidden = !Object.keys(state.discounts).length;
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!document.documentElement.dataset.theme) void cmap.applyTheme(currentTheme());
});

// ── Live status / polling ───────────────────────────────────────────────

liveBtn.addEventListener("click", () => void refresh(true));
let pollTimer = 0;
function schedulePoll(): void {
  clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
}
document.addEventListener("visibilitychange", () => {
  // Don't keep high-accuracy GPS running in the background.
  if (document.visibilityState === "hidden") stopWatch();
  else if (state.user && watchId === null) locate(false, true);
  if (document.visibilityState === "visible" && state.payload) {
    const age = Date.now() - Date.parse(state.payload.fetchedAt);
    if (!(age < POLL_MS)) void refresh();
  }
});
window.addEventListener("online", () => void refresh());

// ── Keyboard ────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (settingsEl.open) return; // the dialog handles its own keys
  const typing = (e.target as HTMLElement).closest("input, textarea");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === "Escape" && !typing) {
    if (menuEl) closeMenus();
    else if (state.selected) closeDetail();
  }
});

// ── Boot ────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  renderFilters();
  renderList();
  hideSplash();
  if (wantDemo) await showDemo();
  else await refresh();
  schedulePoll();

  // Re-locate silently if the user granted permission before.
  try {
    const perm = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    if (perm?.state === "granted" || (perm?.state !== "denied" && store.get("located", false))) locate(!readHash(), true);
    else if (!readHash() && !reducedMotion()) {
      // Cinematic intro: settle from the island view into the city with a gentle tilt.
      setTimeout(() => cmap.flyTo(SG_CENTER, 11.3, sheet.settledHeight, 25), 900);
    }
  } catch {
    /* permissions API unsupported */
  }
}

void boot();
registerPwa((update) => toast("A new version of ChargeIt is ready.", { label: "Reload", run: update }, 15_000));

// Expose a tiny hook for end-to-end tests.
(window as unknown as { __chargeit: unknown }).__chargeit = { state, sheet, cmap };
