/**
 * Local-time date helpers for the grids. All Date values here are LOCAL wall-clock anchors
 * (midnights, week starts); event instants arrive as server-computed UTCDateTime strings and are
 * converted via `new Date(utc)`. Weeks start Monday.
 */

export const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local date key "YYYY-MM-DD". */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as LOCAL midnight (never the UTC-midnight Date("YYYY-MM-DD") trap). */
export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** RFC 8984 LocalDateTime for a local Date's wall-clock (query bounds). */
export function toLocalDateTime(d: Date): string {
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return out;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday-start week. */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 42-cell month grid start (Monday on/before the 1st). */
export function monthGridStart(d: Date): Date {
  return startOfWeek(startOfMonth(d));
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function isToday(d: Date): boolean {
  return sameDay(d, new Date());
}

/** ISO-8601 week number. */
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604_800_000);
}

/**
 * RFC 8984 LocalDateTime + IANA zone → UTC instant, without Temporal: guess, measure the zone's
 * offset at the guess via Intl, correct, repeat once (stabilizes across DST edges).
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const [dPart, tPart = "00:00:00"] = local.split("T");
  const [y, m, d] = dPart.split("-").map(Number);
  const [hh = 0, mm = 0, ss = 0] = tPart.split(":").map((v) => Number(v) || 0);
  const wall = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh, mm, ss);

  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(y, (m ?? 1) - 1, d ?? 1, hh, mm, ss);
  }

  const offsetAt = (t: number): number => {
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(t)) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(
      parts.year,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour === 24 ? 0 : parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    return asUtc - t;
  };

  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

/** ISO-8601 duration → milliseconds (weeks/days/h/m/s; calendar-exactness not needed here). */
export function durationToMs(duration: string): number {
  const m = duration.match(
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!m) return 0;
  const [, w, d, h, min, s] = m;
  return ((Number(w) || 0) * 7 * 86_400 + (Number(d) || 0) * 86_400 + (Number(h) || 0) * 3_600 +
    (Number(min) || 0) * 60 + (Number(s) || 0)) * 1000;
}

/** Minutes since local midnight of `day` for an instant, clamped to [0, 1440]. */
export function minutesInDay(instant: Date, day: Date): number {
  const midnight = startOfDay(day).getTime();
  return Math.max(0, Math.min(1440, (instant.getTime() - midnight) / 60_000));
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthTitleFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayMonthFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const miniMonthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function fmtTime(d: Date): string {
  return timeFmt.format(d);
}

export function fmtWeekday(d: Date): string {
  return weekdayFmt.format(d);
}

export function fmtMonthTitle(d: Date): string {
  return monthTitleFmt.format(d);
}

export function fmtMiniMonth(d: Date): string {
  return miniMonthFmt.format(d);
}

/** "Jul 9 – Aug 8, 2026" for arbitrary ranges (agenda title). */
export function fmtRangeTitle(start: Date, endInclusive: Date): string {
  return `${dayMonthFmt.format(start)} – ${dayMonthFmt.format(endInclusive)}, ${endInclusive.getFullYear()}`;
}

/** "Jul 6 – 12, 2026" (or spanning months: "Jun 29 – Jul 5, 2026"). */
export function fmtWeekTitle(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const left = dayMonthFmt.format(weekStart);
  const right = weekStart.getMonth() === end.getMonth()
    ? String(end.getDate())
    : dayMonthFmt.format(end);
  return `${left} – ${right}, ${end.getFullYear()}`;
}

/** Hour label for the week-view gutter ("14:00" / "2 PM" per locale). */
export function fmtHour(hour: number): string {
  return timeFmt.format(new Date(2026, 0, 1, hour));
}
