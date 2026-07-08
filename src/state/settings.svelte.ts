/** Persisted display settings (runes module, localStorage-backed). */

export interface CustomCalendar {
  /** Slug used in the setting value ("custom:<id>"). */
  id: string;
  name: string;
  /** Gregorian date that is year 1, month 1, day 1 of this calendar. */
  epoch: string;
  months: { name: string; days: number }[];
  /**
   * Optional leap rule: add `days` to month number `month` (1-based) in every year where
   * (year - 1 - offsetYears) % everyYears === 0.
   */
  leap?: { everyYears: number; month: number; days: number; offsetYears?: number };
  /** Added to the computed year for display (era offsets). */
  yearOffset?: number;
  /** Display template; tokens: {day} {month} {monthNum} {year}. */
  format?: string;
}

export interface Settings {
  /** "none" | "ca:<intl calendar>" | "custom:<id>". */
  secondaryCalendar: string;
  customCalendars: CustomCalendar[];
  weekNumbers: boolean;
  showDeclined: boolean;
  /** Week view pixels per hour. */
  hourHeight: number;
}

const KEY = "sundog.settings";

const DEFAULTS: Settings = {
  secondaryCalendar: "none",
  customCalendars: [],
  weekNumbers: false,
  showDeclined: true,
  hourHeight: 48,
};

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = $state(load());

export function persistSettings(): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
