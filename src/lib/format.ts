/** Formatting helpers for event details: ranges, zones, durations, geo URIs, linkification. */
import { addDays, BROWSER_TZ, sameDay } from "./dates.ts";

/** Split text into alternating [text, url, text, …] parts for safe linkified rendering. */
export function linkify(text: string): { text: string; isUrl: boolean }[] {
  const parts: { text: string; isUrl: boolean }[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index! > last) parts.push({ text: text.slice(last, match.index), isUrl: false });
    parts.push({ text: match[0], isUrl: true });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), isUrl: false });
  return parts;
}

/** Render text/html descriptions as plain text (parse only — nothing executes). */
export function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** "geo:41.84,23.48;u=30" → { lat, lon, u? } (u = RFC 5870 uncertainty in meters). */
export function geoToLatLon(
  coordinates: string,
): { lat: number; lon: number; u?: number } | undefined {
  const m = coordinates.match(/^geo:(-?[\d.]+),(-?[\d.]+)/i);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const um = coordinates.match(/;u=(\d+(?:\.\d+)?)/i);
  const u = um ? Number(um[1]) : undefined;
  return Number.isFinite(u) ? { lat, lon, u } : { lat, lon };
}

/**
 * Directions to a place: Apple Maps universal link on Apple platforms (opens the native app),
 * Google Maps elsewhere. Coordinates win; falls back to the place name as the query.
 */
export function directionsUrl(
  dest: { coordinates?: string; name?: string },
): string | undefined {
  const ll = dest.coordinates ? geoToLatLon(dest.coordinates) : undefined;
  const name = dest.name?.trim();
  // A URL-shaped "place" (meet links stored as locations) is not routable.
  const target = ll ? `${ll.lat},${ll.lon}` : /^https?:\/\//i.test(name ?? "") ? undefined : name;
  if (!target) return undefined;
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(target)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(target)}`;
}

/** "geo:41.84,23.48;u=30" → OpenStreetMap URL, or undefined when unparsable. */
export function geoToMapUrl(coordinates: string): string | undefined {
  const ll = geoToLatLon(coordinates);
  if (!ll) return undefined;
  return `https://www.openstreetmap.org/?mlat=${ll.lat}&mlon=${ll.lon}#map=17/${ll.lat}/${ll.lon}`;
}

const DUR_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** "-P1D" → "1 day before", "-PT15M" → "15 min before", "PT5M" → "5 min after". */
export function humanizeOffset(offset: string, relativeTo?: "start" | "end"): string {
  const m = offset.match(DUR_RE);
  if (!m) return offset;
  const [, sign, w, d, h, min, s] = m;
  const units: string[] = [];
  if (w && +w) units.push(`${+w} wk`);
  if (d && +d) units.push(`${+d} day${+d === 1 ? "" : "s"}`);
  if (h && +h) units.push(`${+h} hr`);
  if (min && +min) units.push(`${+min} min`);
  if (s && +s) units.push(`${+s} sec`);
  const amount = units.length ? units.join(" ") : "0 min";
  const anchor = relativeTo === "end" ? " end" : "";
  return sign === "-" ? `${amount} before${anchor}` : `at${anchor || " start"} + ${amount}`;
}

const dayLongFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const dayLongYearFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function fmtDayLong(d: Date): string {
  const withYear = d.getFullYear() !== new Date().getFullYear();
  return (withYear ? dayLongYearFmt : dayLongFmt).format(d);
}

const zonedTimeCache = new Map<string, Intl.DateTimeFormat>();

/** "13:09" in an arbitrary IANA zone (falls back to browser zone on bad input). */
export function fmtTimeInZone(instant: Date, timeZone: string): string {
  let fmt = zonedTimeCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      });
    } catch {
      fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    }
    zonedTimeCache.set(timeZone, fmt);
  }
  return fmt.format(instant);
}

export interface RangeParts {
  /** "Thu, Jul 9" (start day). */
  day: string;
  /** "13:09 – 15:48" or "Jul 9, 13:09 → Jul 10, 06:30" or "All day". */
  time: string;
}

/** Human range in the BROWSER zone. */
export function fmtRange(utcStart: string, utcEnd: string, allDay: boolean): RangeParts {
  const s = new Date(utcStart);
  const e = new Date(utcEnd);
  if (allDay) {
    // End is exclusive for whole-day spans: a 1-day event ends at next midnight.
    const lastDay = e.getTime() > s.getTime() ? addDays(e, 0) : e;
    const inclusiveEnd = new Date(Math.max(lastDay.getTime() - 1, s.getTime()));
    return sameDay(s, inclusiveEnd)
      ? { day: fmtDayLong(s), time: "All day" }
      : { day: `${fmtDayLong(s)} – ${fmtDayLong(inclusiveEnd)}`, time: "All day" };
  }
  if (sameDay(s, e) || s.getTime() === e.getTime()) {
    return {
      day: fmtDayLong(s),
      time: `${fmtTimeInZone(s, BROWSER_TZ)} – ${fmtTimeInZone(e, BROWSER_TZ)}`,
    };
  }
  return {
    day: fmtDayLong(s),
    time: `${fmtTimeInZone(s, BROWSER_TZ)} → ${fmtDayLong(e)}, ${fmtTimeInZone(e, BROWSER_TZ)}`,
  };
}
