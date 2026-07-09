<script module lang="ts">
  export interface MapPoint {
    /** Stable key linking the pin to its location row (hover coordination). */
    key: string;
    lat: number;
    lon: number;
    /** "Departure" / "Arrival" / "Location" — drives the pin letter and tooltip. */
    label: string;
    name?: string;
    /** RFC 5870 uncertainty in meters, when the geo: URI carried ;u=. */
    u?: number;
  }
</script>

<script lang="ts">
  /**
   * Inline Leaflet map for event locations. CARTO basemaps (voyager light / dark raster) —
   * purpose-built for both themes, no CSS-filter hacks. Leaflet is loaded lazily on first mount
   * so calendar views never pay for it. Attribution is the collapsed-ⓘ pattern: required credits
   * (OSM data © / CARTO tiles ©) expand on hover or tap, no "Leaflet" prefix.
   */
  import "leaflet/dist/leaflet.css";
  import type * as Leaflet from "leaflet";

  interface Props {
    points: MapPoint[];
    /** Pin key to emphasize (row → pin hover coordination). */
    highlightKey?: string | null;
    /** Pin hover callback (pin → row coordination). null = hover left. */
    onHover?: (key: string | null) => void;
    /** Picker mode: clicking the map reports a position; map starts fully interactive. */
    onPick?: (lat: number, lon: number) => void;
    /** Fallback view for a pointless picker map (after a failed geocode). */
    center?: { lat: number; lon: number; zoom: number };
  }

  const { points, highlightKey = null, onHover, onPick, center }: Props = $props();

  let el: HTMLDivElement | undefined = $state();
  let engaged = $state(false);
  let markers = $state<Record<string, Leaflet.Marker>>({});
  let mapRef: Leaflet.Map | undefined;

  const TILE_URLS = {
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png",
  };

  // --- geometry ------------------------------------------------------------------------------

  const RAD = Math.PI / 180;

  function haversineKm(a: MapPoint, b: MapPoint): number {
    const dLat = (b.lat - a.lat) * RAD;
    const dLon = (b.lon - a.lon) * RAD;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 12_742 * Math.asin(Math.sqrt(s));
  }

  /** Great-circle interpolation (spherical slerp), longitudes unwrapped for clean polylines. */
  function greatCircle(a: MapPoint, b: MapPoint, segments = 64): [number, number][] {
    const v = (p: MapPoint): [number, number, number] => [
      Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD),
      Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD),
      Math.sin(p.lat * RAD),
    ];
    const v1 = v(a);
    const v2 = v(b);
    const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    const omega = Math.acos(dot);
    if (omega < 1e-6) return [[a.lat, a.lon], [b.lat, b.lon]];
    const out: [number, number][] = [];
    let prevLon = a.lon;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const k1 = Math.sin((1 - t) * omega) / Math.sin(omega);
      const k2 = Math.sin(t * omega) / Math.sin(omega);
      const x = k1 * v1[0] + k2 * v2[0];
      const y = k1 * v1[1] + k2 * v2[1];
      const z = k1 * v1[2] + k2 * v2[2];
      const lat = Math.atan2(z, Math.hypot(x, y)) / RAD;
      let lon = Math.atan2(y, x) / RAD;
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      prevLon = lon;
      out.push([lat, lon]);
    }
    return out;
  }

  /** RFC 5870 ;u= (meters) → tile zoom; travel legs default wide, plain places street-level. */
  function zoomFor(p: MapPoint): number {
    if (p.u !== undefined) {
      if (p.u <= 25) return 17;
      if (p.u <= 100) return 16;
      if (p.u <= 400) return 15;
      if (p.u <= 1_500) return 14;
      if (p.u <= 5_000) return 13;
      if (p.u <= 20_000) return 12;
      return 11;
    }
    return p.label === "Departure" || p.label === "Arrival" ? 13 : 15;
  }

  function travelPair(pts: MapPoint[]): [MapPoint, MapPoint] | undefined {
    const dep = pts.find((p) => p.label === "Departure");
    const arr = pts.find((p) => p.label === "Arrival");
    return dep && arr ? [dep, arr] : undefined;
  }

  function pinIcon(L: typeof Leaflet, label: string): Leaflet.DivIcon {
    const letter = label === "Departure" ? "D" : label === "Arrival" ? "A" : "";
    return L.divIcon({
      className: "sd-pin-wrap",
      html: `<span class="sd-pin${letter ? " sd-pin-lettered" : ""}">${letter}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  // --- map lifecycle ---------------------------------------------------------------------------

  $effect(() => {
    const container = el;
    const pts = points;
    const fallback = center;
    if (!container || (!pts.length && !fallback)) return;

    let map: Leaflet.Map | undefined;
    let cancelled = false;
    let darkMq: MediaQueryList | undefined;
    let onScheme: (() => void) | undefined;

    engaged = !!onPick; // pickers are interactive from the start
    markers = {};

    import("leaflet").then(({ default: L }) => {
      if (cancelled) return;
      map = L.map(container, {
        zoomControl: false,
        dragging: !!onPick,
        scrollWheelZoom: !!onPick,
        attributionControl: false,
      });
      mapRef = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);

      // CARTO basemap following the color scheme live.
      darkMq = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
      const tiles = L.tileLayer(TILE_URLS[darkMq?.matches ? "dark" : "light"], {
        subdomains: "abcd",
        maxZoom: 20,
      }).addTo(map);
      onScheme = () => tiles.setUrl(TILE_URLS[darkMq!.matches ? "dark" : "light"]);
      darkMq?.addEventListener("change", onScheme);

      // Collapsed-ⓘ credits (required by OSM/CARTO terms; expanded on hover or tap).
      const Credits = L.Control.extend({
        options: { position: "bottomleft" },
        onAdd() {
          const div = L.DomUtil.create("div", "sd-credits");
          div.innerHTML =
            `<span class="sd-credits-text">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> © <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a></span><button class="sd-credits-toggle" aria-label="Map credits" title="Map credits">ⓘ</button>`;
          L.DomEvent.disableClickPropagation(div);
          div.querySelector("button")!.addEventListener(
            "click",
            () => div.classList.toggle("open"),
          );
          return div;
        },
      });
      map.addControl(new Credits());

      for (const p of pts) {
        const marker = L.marker([p.lat, p.lon], { icon: pinIcon(L, p.label) }).addTo(map);
        const title = p.name
          ? `${p.label === "Location" ? "" : p.label + " · "}${p.name}`
          : p.label;
        marker.bindTooltip(title, { direction: "top", offset: [0, -10] });
        marker.on("mouseover", () => onHover?.(p.key));
        marker.on("mouseout", () => onHover?.(null));
        markers[p.key] = marker;
      }

      // Travel connector: great-circle arc for flight-length hops, straight dashes for ground.
      const pair = travelPair(pts);
      if (pair) {
        const latlngs = haversineKm(pair[0], pair[1]) >= 300
          ? greatCircle(pair[0], pair[1])
          : pair.map((p) => [p.lat, p.lon] as [number, number]);
        L.polyline(latlngs, {
          dashArray: "4 6",
          weight: 2,
          opacity: 0.7,
          className: "sd-route",
        }).addTo(map);
      }

      if (pts.length === 1) {
        map.setView([pts[0].lat, pts[0].lon], zoomFor(pts[0]));
      } else if (pts.length > 1) {
        map.fitBounds(
          L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number])),
          { padding: [28, 28], maxZoom: 15 },
        );
      } else if (fallback) {
        map.setView([fallback.lat, fallback.lon], fallback.zoom);
      }

      if (onPick) {
        map.on("click", (e: Leaflet.LeafletMouseEvent) => {
          onPick(
            Math.round(e.latlng.lat * 1e6) / 1e6,
            Math.round(((e.latlng.lng + 540) % 360 - 180) * 1e6) / 1e6,
          );
        });
      }
    });

    return () => {
      cancelled = true;
      if (darkMq && onScheme) darkMq.removeEventListener("change", onScheme);
      map?.remove();
      if (mapRef === map) mapRef = undefined;
      markers = {};
    };
  });

  /** First deliberate click unlocks pan/zoom, so popover scrolling never fights the map. */
  function engage(): void {
    if (engaged) return;
    engaged = true;
    mapRef?.dragging.enable();
    mapRef?.scrollWheelZoom.enable();
  }

  // Row → pin highlight.
  $effect(() => {
    const hot = highlightKey;
    for (const [key, marker] of Object.entries(markers)) {
      marker.getElement()?.querySelector(".sd-pin")?.classList.toggle("sd-pin-hot", key === hot);
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="loc-map"
  class:engaged
  class:picker={!!onPick}
  bind:this={el}
  onclick={engage}
  aria-label="Map of event locations"
>
  {#if !engaged}
    <span class="hint" aria-hidden="true">Click to interact</span>
  {/if}
</div>

<style>
  .loc-map {
    position: relative;
    height: 150px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--panel);
    /* Leaflet sets its own z-indexes up to 1000; keep the stack local to the popover. */
    isolation: isolate;
  }

  .loc-map.picker {
    cursor: crosshair;
  }

  .hint {
    position: absolute;
    left: 50%;
    bottom: 8px;
    transform: translateX(-50%);
    z-index: 1001;
    font-size: 0.66rem;
    color: var(--ink-soft);
    background: color-mix(in oklab, var(--raised) 88%, transparent);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .loc-map:hover .hint {
    opacity: 1;
  }

  .loc-map :global(.leaflet-container) {
    height: 100%;
    background: var(--panel);
    font-family: var(--font-ui);
  }

  .loc-map :global(.sd-pin) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50% 50% 50% 4px;
    background: var(--ev, var(--amber));
    border: 2px solid var(--raised);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
    color: var(--ground);
    font-size: 0.62rem;
    font-weight: 700;
    transform: rotate(-45deg);
    transition: transform 0.12s, box-shadow 0.12s;
  }

  .loc-map :global(.sd-pin-lettered) {
    transform: none;
    border-radius: 50%;
  }

  .loc-map :global(.sd-pin-hot) {
    transform: scale(1.25);
    box-shadow:
      0 0 0 3px color-mix(in oklab, var(--ev, var(--amber)) 35%, transparent),
      0 1px 5px rgb(0 0 0 / 0.4);
  }

  .loc-map :global(.sd-pin.sd-pin-hot:not(.sd-pin-lettered)) {
    transform: rotate(-45deg) scale(1.25);
  }

  .loc-map :global(.sd-route) {
    stroke: var(--ev, var(--amber));
  }

  .loc-map :global(.leaflet-tooltip) {
    background: var(--raised);
    border: 1px solid var(--line);
    color: var(--ink);
    font-size: 0.72rem;
    box-shadow: var(--shadow);
  }

  .loc-map :global(.leaflet-tooltip-top::before) {
    border-top-color: var(--line);
  }

  /* Collapsed-ⓘ credits */
  .loc-map :global(.sd-credits) {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 0 4px 4px;
  }

  .loc-map :global(.sd-credits-toggle) {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: none;
    background: color-mix(in oklab, var(--raised) 82%, transparent);
    color: var(--ink-faint);
    font-size: 0.62rem;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .loc-map :global(.sd-credits-text) {
    display: none;
    font-size: 0.6rem;
    color: var(--ink-soft);
    background: color-mix(in oklab, var(--raised) 88%, transparent);
    border-radius: 4px;
    padding: 0.05rem 0.35rem;
    white-space: nowrap;
  }

  .loc-map :global(.sd-credits:hover .sd-credits-text),
  .loc-map :global(.sd-credits.open .sd-credits-text) {
    display: inline;
  }

  .loc-map :global(.sd-credits-text a) {
    color: var(--ink-soft);
  }

  .loc-map :global(.leaflet-control-zoom a) {
    background: var(--raised);
    color: var(--ink);
    border-color: var(--line);
    width: 22px;
    height: 22px;
    line-height: 22px;
    font-size: 0.85rem;
  }
</style>
