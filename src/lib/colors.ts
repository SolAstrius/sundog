/** Calendar/event color resolution. Calendars may carry a CSS color; fall back by index. */
import type { CalendarInfo, EventInstance } from "../jmap/calendar.ts";

const FALLBACKS = [
  "#b4691e",
  "#46708f",
  "#7a5ea6",
  "#4a7a4e",
  "#a05275",
  "#8a6d3b",
  "#3f7d7a",
];

export function calendarColor(cal: CalendarInfo, index: number): string {
  return cal.color ?? FALLBACKS[index % FALLBACKS.length];
}

export function buildColorMap(calendars: CalendarInfo[]): Record<string, string> {
  const map: Record<string, string> = {};
  calendars.forEach((cal, i) => {
    map[cal.id] = calendarColor(cal, i);
  });
  return map;
}

/** Event color: own color → first containing calendar's color → default amber. */
export function eventColor(event: EventInstance, colorMap: Record<string, string>): string {
  if (event.color) return event.color;
  for (const id of Object.keys(event.calendarIds)) {
    if (colorMap[id]) return colorMap[id];
  }
  return FALLBACKS[0];
}
