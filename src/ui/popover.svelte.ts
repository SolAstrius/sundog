/** Popover state (runes module): one popover at a time — event detail or day-overflow list. */
import type { EventInstance } from "../jmap/calendar.ts";

export interface PopoverAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DayItem {
  ev: EventInstance;
  color: string;
}

export const pop = $state({
  kind: "closed" as "closed" | "event" | "day",
  ev: undefined as EventInstance | undefined,
  evColor: "",
  dayLabel: "",
  dayItems: [] as DayItem[],
  anchor: undefined as PopoverAnchor | undefined,
});

function anchorFrom(el?: Element | null): PopoverAnchor | undefined {
  const rect = el?.getBoundingClientRect();
  if (!rect) return undefined;
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

export function openEvent(ev: EventInstance, color: string, el?: Element | null): void {
  pop.kind = "event";
  pop.ev = ev;
  pop.evColor = color;
  pop.anchor = anchorFrom(el) ?? pop.anchor;
}

export function openDay(label: string, items: DayItem[], el?: Element | null): void {
  pop.kind = "day";
  pop.dayLabel = label;
  pop.dayItems = items;
  pop.anchor = anchorFrom(el);
}

export function closePopover(): void {
  pop.kind = "closed";
  pop.ev = undefined;
  pop.dayItems = [];
  pop.anchor = undefined;
}
