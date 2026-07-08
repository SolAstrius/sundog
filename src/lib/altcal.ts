/**
 * Secondary calendar systems: Intl-provided traditional calendars (Hebrew, Hijri, Chinese
 * lunisolar, …) plus fully generic user-defined calendars (fantasy/conlang) described as data —
 * an epoch, a month table, and an optional leap rule.
 */
import { startOfDay } from "./dates.ts";
import { type CustomCalendar, settings } from "../state/settings.svelte.ts";

/** Intl calendar ids offered in settings (all shipped by ICU in evergreen browsers). */
export const INTL_CALENDARS: { id: string; name: string }[] = [
  { id: "hebrew", name: "Hebrew" },
  { id: "islamic-umalqura", name: "Islamic (Umm al-Qura)" },
  { id: "islamic-civil", name: "Islamic (civil)" },
  { id: "chinese", name: "Chinese lunisolar" },
  { id: "persian", name: "Persian (Solar Hijri)" },
  { id: "indian", name: "Indian national" },
  { id: "coptic", name: "Coptic" },
  { id: "ethiopic", name: "Ethiopic" },
  { id: "buddhist", name: "Buddhist" },
  { id: "japanese", name: "Japanese eras" },
  { id: "roc", name: "Minguo (ROC)" },
];

const intlCache = new Map<string, Intl.DateTimeFormat | null>();

function intlFormatter(calendar: string, long: boolean): Intl.DateTimeFormat | null {
  const key = `${calendar}|${long}`;
  if (!intlCache.has(key)) {
    try {
      intlCache.set(
        key,
        new Intl.DateTimeFormat(undefined, {
          calendar,
          day: "numeric",
          month: long ? "long" : "short",
          year: long ? "numeric" : undefined,
        }),
      );
    } catch {
      intlCache.set(key, null);
    }
  }
  return intlCache.get(key) ?? null;
}

// --- generic custom calendar engine ----------------------------------------------------------

export interface CustomDate {
  year: number;
  /** 1-based. */
  month: number;
  day: number;
  monthName: string;
}

function yearLength(cal: CustomCalendar, year: number): number {
  const base = cal.months.reduce((sum, m) => sum + m.days, 0);
  return base + (isLeapYear(cal, year) ? cal.leap!.days : 0);
}

function isLeapYear(cal: CustomCalendar, year: number): boolean {
  const leap = cal.leap;
  if (!leap || leap.everyYears <= 0 || leap.days <= 0) return false;
  const n = year - 1 - (leap.offsetYears ?? 0);
  return ((n % leap.everyYears) + leap.everyYears) % leap.everyYears === 0;
}

function monthLength(cal: CustomCalendar, year: number, month1: number): number {
  const base = cal.months[month1 - 1]?.days ?? 30;
  return base + (isLeapYear(cal, year) && cal.leap!.month === month1 ? cal.leap!.days : 0);
}

/** Convert a (local) Date into the custom calendar. Handles dates before the epoch. */
export function toCustomDate(cal: CustomCalendar, d: Date): CustomDate | undefined {
  const [ey, em, ed] = cal.epoch.split("-").map(Number);
  if (!ey || !em || !ed || cal.months.length === 0) return undefined;
  const epoch = new Date(ey, em - 1, ed).getTime();
  let days = Math.round((startOfDay(d).getTime() - epoch) / 86_400_000);

  let year = 1;
  if (days >= 0) {
    let len = yearLength(cal, year);
    // Bounded loop: even a 1-day year across 10k years terminates.
    while (days >= len && year < 100_000) {
      days -= len;
      year++;
      len = yearLength(cal, year);
    }
  } else {
    while (days < 0 && year > -100_000) {
      year--;
      days += yearLength(cal, year);
    }
  }

  let month = 1;
  while (month < cal.months.length && days >= monthLength(cal, year, month)) {
    days -= monthLength(cal, year, month);
    month++;
  }
  return {
    year: year + (cal.yearOffset ?? 0),
    month,
    day: days + 1,
    monthName: cal.months[month - 1].name,
  };
}

export function fmtCustomDate(cal: CustomCalendar, d: Date, long: boolean): string | undefined {
  const cd = toCustomDate(cal, d);
  if (!cd) return undefined;
  const template = long ? (cal.format ?? "{day} {month} {year}") : "{day} {month}";
  return template
    .replaceAll("{day}", String(cd.day))
    .replaceAll("{month}", cd.monthName)
    .replaceAll("{monthNum}", String(cd.month))
    .replaceAll("{year}", String(cd.year));
}

/** Returns a human error, or null when the definition is usable. */
export function validateCustomCalendar(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return "Definition must be a JSON object.";
  const cal = obj as Partial<CustomCalendar>;
  if (!cal.id || !/^[a-z0-9-]+$/.test(cal.id)) {
    return 'Needs an "id" (lowercase letters, digits, dashes).';
  }
  if (!cal.name) return 'Needs a "name".';
  if (!cal.epoch || !/^\d{4}-\d{2}-\d{2}$/.test(cal.epoch)) {
    return 'Needs an "epoch" Gregorian date like "2020-03-20" (= year 1, day 1).';
  }
  if (!Array.isArray(cal.months) || cal.months.length === 0) {
    return 'Needs a non-empty "months" array of {name, days}.';
  }
  for (const m of cal.months) {
    if (!m || typeof m.name !== "string" || !Number.isInteger(m.days) || m.days < 1) {
      return 'Every month needs a "name" and integer "days" ≥ 1.';
    }
  }
  if (cal.leap) {
    const { everyYears, month, days } = cal.leap;
    if (!Number.isInteger(everyYears) || everyYears < 1) {
      return "leap.everyYears must be a positive integer.";
    }
    if (!Number.isInteger(month) || month < 1 || month > cal.months.length) {
      return "leap.month must reference an existing month (1-based).";
    }
    if (!Number.isInteger(days) || days < 1) return "leap.days must be a positive integer.";
  }
  return null;
}

export const EXAMPLE_CUSTOM: CustomCalendar = {
  id: "selunar",
  name: "Selunar",
  epoch: "2020-03-20",
  months: [
    { name: "Auren", days: 28 },
    { name: "Bellis", days: 28 },
    { name: "Cerule", days: 28 },
    { name: "Dorane", days: 28 },
    { name: "Emberi", days: 28 },
    { name: "Feyril", days: 28 },
    { name: "Galeth", days: 28 },
    { name: "Hollow", days: 28 },
    { name: "Ithres", days: 28 },
    { name: "Jasperi", days: 28 },
    { name: "Kyrune", days: 28 },
    { name: "Lumen", days: 28 },
    { name: "Mireth", days: 29 },
  ],
  leap: { everyYears: 4, month: 13, days: 1 },
  format: "{day} {month}, {year} SE",
};

// --- unified secondary-date formatting --------------------------------------------------------

function activeCustom(): CustomCalendar | undefined {
  const value = settings.secondaryCalendar;
  if (!value.startsWith("custom:")) return undefined;
  const id = value.slice("custom:".length);
  return settings.customCalendars.find((c) => c.id === id);
}

/** Secondary-calendar rendering of a date per the active setting; undefined when off/broken. */
export function fmtSecondary(d: Date, long = false): string | undefined {
  const value = settings.secondaryCalendar;
  if (!value || value === "none") return undefined;
  if (value.startsWith("ca:")) {
    return intlFormatter(value.slice(3), long)?.format(d);
  }
  const custom = activeCustom();
  return custom ? fmtCustomDate(custom, d, long) : undefined;
}

export function secondaryCalendarName(): string | undefined {
  const value = settings.secondaryCalendar;
  if (!value || value === "none") return undefined;
  if (value.startsWith("ca:")) {
    return INTL_CALENDARS.find((c) => c.id === value.slice(3))?.name ?? value.slice(3);
  }
  return activeCustom()?.name;
}
