/** Popover state (runes module): one popover at a time — event detail, day-overflow, or editor. */
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

/** Editor seed: `ev` present ⇒ editing, absent ⇒ creating at the given instants. */
export interface EditSeed {
  ev?: EventInstance;
  startMs: number;
  endMs: number;
  allDay: boolean;
}

export const pop = $state({
  kind: "closed" as "closed" | "event" | "day" | "edit",
  ev: undefined as EventInstance | undefined,
  evColor: "",
  dayLabel: "",
  dayItems: [] as DayItem[],
  edit: undefined as EditSeed | undefined,
  anchor: undefined as PopoverAnchor | undefined,
});

function anchorFrom(el?: Element | PopoverAnchor | null): PopoverAnchor | undefined {
  if (el && !(el instanceof Element)) return el;
  const rect = el?.getBoundingClientRect();
  if (!rect) return undefined;
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

export function openEvent(ev: EventInstance, color: string, el?: Element | null): void {
  pop.kind = "event";
  pop.ev = ev;
  pop.evColor = color;
  pop.edit = undefined;
  pop.anchor = anchorFrom(el) ?? pop.anchor;
}

export function openDay(label: string, items: DayItem[], el?: Element | null): void {
  pop.kind = "day";
  pop.dayLabel = label;
  pop.dayItems = items;
  pop.edit = undefined;
  pop.anchor = anchorFrom(el);
}

export function openEditor(seed: EditSeed, el?: Element | PopoverAnchor | null): void {
  pop.kind = "edit";
  pop.ev = seed.ev;
  pop.edit = seed;
  pop.dayItems = [];
  pop.anchor = anchorFrom(el) ?? pop.anchor;
}

export function closePopover(): void {
  pop.kind = "closed";
  pop.ev = undefined;
  pop.dayItems = [];
  pop.edit = undefined;
  pop.anchor = undefined;
}
