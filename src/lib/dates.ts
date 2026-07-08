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
