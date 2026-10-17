import { Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
// MapLibre resolves its web worker relative to its own module, which a bundler
// moves; hand it the emitted URL explicitly instead.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

setWorkerUrl(workerUrl);
import type { Availability, Operator, StationVM } from "./model.ts";
import { reducedMotion } from "./motion.ts";
import { pinHtml } from "./pin.ts";

export type Theme = "dark" | "light";

const STYLE_URL: Record<Theme, string> = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

export const SG_CENTER: [number, number] = [103.8198, 1.3521];
const SG_BOUNDS: [[number, number], [number, number]] = [
  [103.35, 1.05],
  [104.35, 1.6],
];

const SOURCE = "stations";

// ── Basemap restyle: the map recedes so the glowing pins lead ───────────

interface Palette {
  bg: string;
  water: string;
  green: string;
  residential: string;
  building: string;
  buildingLine: string;
  extrude: string;
  minor: string;
  major: string;
  casing: string;
  motorway: string;
  rail: string;
  label: string;
  halo: string;
  waterLabel: string;
  boundary: string;
}

const PALETTES: Record<Theme, Palette> = {
  dark: {
    bg: "#070B16",
    water: "#0C1A33",
    green: "#0A1A1F",
    residential: "#0A1020",
    building: "#0F172B",
    buildingLine: "#16203A",
    extrude: "#121B33",
    minor: "#141E37",
    major: "#1C2948",
    casing: "#22304F",
    motorway: "#283A62",
    rail: "#18223D",
    label: "#6F80A6",
    halo: "#070B16",
    waterLabel: "#3D5A8C",
    boundary: "#2A3756",
  },
  light: {
    bg: "#F4F7FB",
    water: "#CFE2F5",
    green: "#DDEFE6",
    residential: "#EEF2F8",
    building: "#E4E9F2",
    buildingLine: "#D6DDEA",
    extrude: "#E2E8F2",
    minor: "#FFFFFF",
    major: "#FFFFFF",
    casing: "#D5DCE8",
    motorway: "#FFFFFF",
    rail: "#D5DCE8",
    label: "#5B6785",
    halo: "#FFFFFF",
    waterLabel: "#6B8CB8",
    boundary: "#B8C2D6",
  },
};

function restyle(style: StyleSpecification, theme: Theme): StyleSpecification {
  const c = PALETTES[theme];
  const set = (layer: { paint?: Record<string, unknown> }, prop: string, value: unknown) => {
    layer.paint = { ...(layer.paint ?? {}), [prop]: value };
  };
  for (const layer of style.layers) {
    const id = layer.id;
    const l = layer as { paint?: Record<string, unknown>; type: string };
    if (layer.type === "background") set(l, "background-color", c.bg);
    else if (layer.type === "fill") {
      if (l.paint && "fill-pattern" in l.paint) delete l.paint["fill-pattern"];
      if (/water/.test(id)) set(l, "fill-color", c.water);
      else if (/park|wood|grass|landcover/.test(id)) set(l, "fill-color", c.green);
      else if (/residential/.test(id)) set(l, "fill-color", c.residential);
      else if (/building/.test(id)) {
        set(l, "fill-color", c.building);
        set(l, "fill-outline-color", c.buildingLine);
      } else if (/aeroway|pier/.test(id)) set(l, "fill-color", c.residential);
    } else if (layer.type === "line") {
      if (/waterway/.test(id)) set(l, "line-color", c.water);
      else if (/boundary/.test(id)) set(l, "line-color", c.boundary);
      else if (/rail/.test(id)) set(l, "line-color", c.rail);
      else if (/casing/.test(id)) set(l, "line-color", c.casing);
      else if (/motorway_inner|motorway_bridge_inner/.test(id)) set(l, "line-color", c.motorway);
      else if (/major_inner/.test(id)) set(l, "line-color", c.major);
      else if (/highway|road|aeroway|path/.test(id)) set(l, "line-color", c.minor);
    } else if (layer.type === "symbol") {
      if (/water/.test(id)) set(l, "text-color", c.waterLabel);
      else set(l, "text-color", c.label);
      set(l, "text-halo-color", c.halo);
    }
  }
  // Subtle 3D buildings when zoomed in and tilted.
  const vector = Object.entries(style.sources).find(([, s]) => s.type === "vector")?.[0];
  if (vector && !style.layers.some((l) => l.id === "ci-3d")) {
    const firstSymbol = style.layers.findIndex((l) => l.type === "symbol");
    style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, {
      id: "ci-3d",
      type: "fill-extrusion",
      source: vector,
      "source-layer": "building",
      minzoom: 15,
      paint: {
        "fill-extrusion-color": c.extrude,
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["coalesce", ["get", "render_height"], 10]],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
  return style;
}

async function loadStyle(theme: Theme): Promise<StyleSpecification> {
  const res = await fetch(STYLE_URL[theme]);
  if (!res.ok) throw new Error(`Map style HTTP ${res.status}`);
  return restyle((await res.json()) as StyleSpecification, theme);
}

/** Minimal offline-safe fallback so the app still works if the tile host is unreachable. */
function blankStyle(theme: Theme): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": PALETTES[theme].bg } }] };
}

// ── Map ─────────────────────────────────────────────────────────────────

interface MarkerEntry {
  marker: Marker;
  el: HTMLElement;
  sig: string;
  coords: [number, number];
  clusterId: number;
}

export interface ChargeMapEvents {
  onSelect: (id: string) => void;
  onMove: () => void;
  onBackgroundClick: () => void;
}

export class ChargeMap {
  readonly map: MLMap;
  private stations: StationVM[] = [];
  private byId = new Map<string, StationVM>();
  private markers = new Map<string, MarkerEntry>();
  private onScreen = new Set<string>();
  private selectedId: string | null = null;
  private me: Marker | null = null;
  private meEl: HTMLElement | null = null;
  private pending = false;
  private theme: Theme;
  private styleReady = false;
  private firstPaint = true;

  constructor(
    container: HTMLElement,
    theme: Theme,
    private events: ChargeMapEvents,
  ) {
    this.theme = theme;
    this.map = new MLMap({
      container,
      style: blankStyle(theme),
      center: SG_CENTER,
      zoom: 10.4,
      minZoom: 9,
      maxZoom: 19,
      maxBounds: SG_BOUNDS,
      attributionControl: { compact: true },
      dragRotate: true,
      pitchWithRotate: true,
      fadeDuration: 150,
    });
    this.map.touchZoomRotate.enableRotation();
    // On wide screens the list floats over the left of the map; keep the camera centred in the open area.
    const pad = () => this.map.setPadding(window.innerWidth >= 820 ? { left: 440, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: 0 });
    pad();
    window.addEventListener("resize", pad);
    this.map.on("style.load", () => this.installLayers());
    // Keep the attribution as a compact (i) so it doesn't cover pins on small screens.
    this.map.once("load", () => container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
    this.map.on("render", () => this.scheduleMarkers());
    this.map.on("moveend", () => {
      if (this.pendingCamera && this.atPendingTarget()) this.pendingCamera = null;
      this.events.onMove();
    });
    // Finish a programmatic trip that a container resize cut short (see pendingCamera).
    this.map.on("resize", () => {
      const p = this.pendingCamera;
      if (!p) return;
      if (Date.now() - p.at > 4000) {
        this.pendingCamera = null; // too old: don't yank the map on a later, unrelated resize
        return;
      }
      requestAnimationFrame(() => {
        if (this.pendingCamera === p && !this.atPendingTarget()) this.moveCamera(p.center, p.zoom, p.bottomPad, p.pitch);
      });
    });
    // The user taking over (drag, pinch, rotate, tilt) cancels any pending trip.
    for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"] as const) {
      this.map.on(ev, (e: { originalEvent?: Event }) => {
        if (e.originalEvent) this.pendingCamera = null;
      });
    }
    this.map.on("click", (e) => {
      const t = e.originalEvent.target as HTMLElement | null;
      if (!t?.closest(".pin")) this.events.onBackgroundClick();
    });
    void this.applyTheme(theme);
  }

  async applyTheme(theme: Theme): Promise<void> {
    this.theme = theme;
    let style: StyleSpecification;
    try {
      style = await loadStyle(theme);
    } catch {
      style = blankStyle(theme);
    }
    if (this.theme !== theme) return; // a newer toggle won
    this.styleReady = false;
    this.map.setStyle(style, { diff: false });
  }

  private installLayers(): void {
    if (!this.map.getSource(SOURCE)) {
      this.map.addSource(SOURCE, {
        type: "geojson",
        data: this.geojson(),
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 58,
        clusterProperties: {
          free: ["+", ["get", "free"]],
          busy: ["+", ["get", "busy"]],
          offline: ["+", ["get", "offline"]],
          dc: ["max", ["get", "dc"]],
          mine: ["max", ["get", "mine"]],
        },
      });
      // Invisible layer: keeps the source's tiles loaded so querySourceFeatures works.
      this.map.addLayer({ id: "stations-anchor", type: "circle", source: SOURCE, paint: { "circle-radius": 1, "circle-opacity": 0 } });
    }
    this.styleReady = true;
    this.scheduleMarkers();
  }

  private geojson(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    return {
      type: "FeatureCollection",
      features: this.stations.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { id: s.id, free: s.sum.free, busy: s.sum.busy, offline: s.sum.offline, dc: s.sum.hasDC ? 1 : 0, mine: this.isMine(s) ? 1 : 0 },
      })),
    };
  }

  private providerOf: (s: StationVM) => { op: Operator; others: number } = () => ({ op: { key: "", name: "", short: "?", color: "", slug: null, logo: null }, others: 0 });

  /** Stations run by one of "my" providers (null = highlighting off). */
  private isMine: (s: StationVM) => boolean = () => false;
  private highlighting = false;

  /**
   * `providerOf` picks the provider badge shown on each station pin; `isMine`
   * (when given) highlights stations run by the user's providers and fades the rest.
   */
  setStations(stations: StationVM[], opts: { providerOf?: (s: StationVM) => { op: Operator; others: number }; isMine?: ((s: StationVM) => boolean) | null } = {}): void {
    if (opts.providerOf) this.providerOf = opts.providerOf;
    if (opts.isMine !== undefined) {
      this.highlighting = opts.isMine !== null;
      this.isMine = opts.isMine ?? (() => false);
    }
    this.stations = stations;
    this.byId = new Map(stations.map((s) => [s.id, s]));
    const src = this.map.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData(this.geojson());
    this.scheduleMarkers();
  }

  private scheduleMarkers(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.updateMarkers();
    });
  }

  private updateMarkers(): void {
    if (!this.styleReady || !this.map.getSource(SOURCE) || !this.map.isSourceLoaded(SOURCE)) return;
    const features = this.map.querySourceFeatures(SOURCE);
    const bounds = this.map.getBounds();
    const pad = 0.01;
    const next = new Set<string>();
    let stagger = 0;
    for (const f of features) {
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      if (coords[0] < bounds.getWest() - pad || coords[0] > bounds.getEast() + pad || coords[1] < bounds.getSouth() - pad || coords[1] > bounds.getNorth() + pad) continue;
      const p = f.properties as Record<string, number | string | boolean>;
      const isCluster = Boolean(p.cluster);
      const key = isCluster ? `c:${p.cluster_id}:${p.point_count}` : `s:${p.id}`;
      if (next.has(key)) continue;
      next.add(key);
      const free = Number(p.free) || 0;
      const busy = Number(p.busy) || 0;
      const offline = Number(p.offline) || 0;
      const st = isCluster ? undefined : this.byId.get(String(p.id));
      const mine = Number(p.mine) === 1;
      const sig = `${free}/${busy}/${offline}/${this.highlighting ? (mine ? "M" : "d") : "-"}${st ? `/${this.providerOf(st).op.name}` : ""}`;
      let entry = this.markers.get(key);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "pin-host";
        if (this.firstPaint && !reducedMotion()) {
          el.style.setProperty("--delay", `${Math.min(stagger++, 40) * 14}ms`);
          el.addEventListener("animationend", () => el.style.removeProperty("--delay"), { once: true });
        }
        const created: MarkerEntry = { marker: new Marker({ element: el }).setLngLat(coords), el, sig: "", coords, clusterId: Number(p.cluster_id) };
        entry = created;
        this.markers.set(key, entry);
        if (isCluster) {
          // Read the entry's *current* cluster id/position: both shift when data refreshes.
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.expandCluster(created.clusterId, created.coords);
          });
        } else {
          const id = String(p.id);
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            this.events.onSelect(id);
          });
        }
      }
      if (entry.coords[0] !== coords[0] || entry.coords[1] !== coords[1]) {
        entry.coords = coords;
        entry.marker.setLngLat(coords);
      }
      if (isCluster) entry.clusterId = Number(p.cluster_id);
      if (entry.sig !== sig) {
        const ticked = entry.sig !== "";
        entry.sig = sig;
        this.renderPin(entry.el, isCluster, { free, busy, offline, dc: Number(p.dc) === 1, count: Number(p.point_count) || 0, id: String(p.id ?? "") });
        const pinEl = entry.el.firstElementChild;
        pinEl?.classList.toggle("is-mine", this.highlighting && mine);
        pinEl?.classList.toggle("is-dim", this.highlighting && !mine);
        if (ticked) {
          const pin = entry.el.firstElementChild as HTMLElement | null;
          pin?.classList.add("is-tick");
          setTimeout(() => pin?.classList.remove("is-tick"), 800);
        }
      }
      if (!this.onScreen.has(key)) entry.marker.addTo(this.map);
    }
    for (const key of this.onScreen) {
      if (!next.has(key)) this.markers.get(key)?.marker.remove();
    }
    // Drop cached cluster markers (cluster ids change with zoom/data) to bound memory.
    if (this.markers.size > 1500) {
      for (const [key, e] of this.markers) {
        if (!next.has(key) && key.startsWith("c:")) {
          e.marker.remove();
          this.markers.delete(key);
        }
      }
    }
    this.onScreen = next;
    if (features.length) this.firstPaint = false;
  }

  private renderPin(
    el: HTMLElement,
    isCluster: boolean,
    d: { free: number; busy: number; offline: number; dc: boolean; count: number; id: string },
  ): void {
    const usable = d.free + d.busy;
    const state: Availability = usable === 0 ? "offline" : d.free === 0 ? "busy" : d.free / usable < 0.34 && usable > 2 ? "few" : "free";
    const sum = { free: d.free, busy: d.busy, offline: d.offline, state, hasDC: d.dc };
    if (isCluster) {
      const size = d.count >= 100 ? " pin--xl" : d.count >= 25 ? " pin--l" : "";
      el.innerHTML = pinHtml({ ...sum, hasDC: false }, `${d.free}<small>${d.count} sites</small>`).replace('class="pin ', `class="pin pin--cluster${size} `);
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `${d.count} charging sites, ${d.free} chargers free. Tap to zoom in.`);
    } else {
      const st = this.byId.get(d.id);
      const provider = st ? this.providerOf(st) : undefined;
      el.innerHTML = pinHtml(sum, undefined, provider);
      el.setAttribute("role", "button");
      const by = provider?.op.name ? `, ${provider.op.name}${provider.others ? ` and ${provider.others} more` : ""}` : "";
      el.setAttribute("aria-label", `${st?.name ?? "Charging site"}${by}: ${d.free} of ${usable} free`);
      if (d.id === this.selectedId) el.firstElementChild?.classList.add("is-selected");
    }
    el.tabIndex = 0;
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.click();
      }
    };
  }

  private async expandCluster(clusterId: number, center: [number, number]): Promise<void> {
    const src = this.map.getSource(SOURCE) as GeoJSONSource;
    try {
      const zoom = await src.getClusterExpansionZoom(clusterId);
      this.map.easeTo({ center, zoom: Math.min(zoom + 0.3, 17), duration: reducedMotion() ? 0 : 650 });
    } catch {
      this.map.easeTo({ center, zoom: this.map.getZoom() + 2 });
    }
  }

  select(id: string | null): void {
    this.selectedId = id;
    for (const [key, e] of this.markers) {
      e.el.firstElementChild?.classList.toggle("is-selected", key === `s:${id}`);
    }
  }

  flyToStation(st: StationVM, bottomPad: number): void {
    const zoom = Math.max(this.map.getZoom(), 15.5);
    this.flyTo([st.lng, st.lat], zoom, bottomPad, 45);
  }

  /**
   * A programmatic camera move in progress. MapLibre cancels a flyTo when the
   * map container resizes, which on phones happens right after picking a search
   * result (the keyboard closes and the viewport grows). We remember the target
   * and finish the trip after such a resize, unless the user has taken over.
   */
  private pendingCamera: { center: [number, number]; zoom: number; bottomPad: number; pitch?: number; at: number } | null = null;

  flyTo(center: [number, number], zoom: number, bottomPad = 0, pitch?: number): void {
    this.pendingCamera = { center, zoom, bottomPad, pitch, at: Date.now() };
    this.moveCamera(center, zoom, bottomPad, pitch);
  }

  private moveCamera(center: [number, number], zoom: number, bottomPad: number, pitch?: number): void {
    const padding = { top: 140, bottom: bottomPad, left: 0, right: 0 };
    if (window.innerWidth >= 820) Object.assign(padding, { left: 440, bottom: 0, top: 0 });
    // Note: MapLibre persists camera padding after flyTo, which is what we want here.
    if (reducedMotion()) {
      this.map.jumpTo({ center, zoom, padding, pitch: pitch ?? this.map.getPitch() });
      return;
    }
    this.map.flyTo({ center, zoom, padding, pitch: pitch ?? this.map.getPitch(), speed: 1.4, curve: 1.5, essential: true });
  }

  private atPendingTarget(): boolean {
    const p = this.pendingCamera;
    if (!p) return true;
    const c = this.map.getCenter();
    return Math.abs(c.lng - p.center[0]) < 1e-4 && Math.abs(c.lat - p.center[1]) < 1e-4 && Math.abs(this.map.getZoom() - p.zoom) < 0.05;
  }

  showUser(pos: { lng: number; lat: number }, ripple: boolean): void {
    if (!this.me) {
      this.meEl = document.createElement("div");
      this.meEl.className = "me";
      this.meEl.innerHTML = `<span class="me__halo"></span><span class="me__ripple"></span><span class="me__ripple"></span><span class="me__dot"></span>`;
      this.meEl.setAttribute("aria-label", "Your location");
      this.me = new Marker({ element: this.meEl }).setLngLat([pos.lng, pos.lat]).addTo(this.map);
    } else {
      this.me.setLngLat([pos.lng, pos.lat]);
    }
    if (ripple && this.meEl) {
      this.meEl.classList.remove("is-ripple");
      void this.meEl.offsetWidth;
      this.meEl.classList.add("is-ripple");
    }
  }

  center(): { lng: number; lat: number } {
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat };
  }

  visibleIds(): Set<string> {
    const b = this.map.getBounds();
    const ids = new Set<string>();
    for (const s of this.stations) if (b.contains([s.lng, s.lat])) ids.add(s.id);
    return ids;
  }
}
