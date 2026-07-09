/**
 * On-demand forward geocoding via Nominatim, localStorage-cached. Only ever called from an
 * explicit user action (a "Show on map" / "Find on map" click), never automatically — that keeps
 * both Nominatim's 1 req/s policy and the privacy surface (leaking event locations to a third
 * party) under user control. Misses are cached too, with a TTL, so retries stay possible.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

const CACHE_PREFIX = "sundog.geocode.";
const MISS_TTL_MS = 7 * 86_400_000;

interface CacheEntry {
  ll: GeoPoint | null;
  t: number;
}

function cacheKey(query: string): string {
  return CACHE_PREFIX + query.trim().toLowerCase();
}

function readCache(query: string): CacheEntry | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(query));
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.ll === null && Date.now() - entry.t > MISS_TTL_MS) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Synchronous cache peek — lets the popover auto-pin places it has geocoded before. */
export function cachedGeocode(query: string): GeoPoint | null | undefined {
  if (!query.trim()) return undefined;
  return readCache(query)?.ll;
}

const inFlight = new Map<string, Promise<GeoPoint | null>>();

/** Resolve a place name to coordinates (null = no match). Deduped and cached. */
export function geocode(query: string): Promise<GeoPoint | null> {
  const q = query.trim();
  if (!q) return Promise.resolve(null);
  const cached = readCache(q);
  if (cached !== undefined) return Promise.resolve(cached.ll);
  const key = cacheKey(q);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${
          encodeURIComponent(q)
        }`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as { lat: string; lon: string }[];
      const ll = rows.length && Number.isFinite(+rows[0].lat) && Number.isFinite(+rows[0].lon)
        ? { lat: +rows[0].lat, lon: +rows[0].lon }
        : null;
      try {
        localStorage.setItem(key, JSON.stringify({ ll, t: Date.now() } satisfies CacheEntry));
      } catch {
        // Storage full/denied — geocode still works, just uncached.
      }
      return ll;
    } catch {
      return null; // network error: NOT cached (readCache miss above), retry allowed
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}
