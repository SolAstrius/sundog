/**
 * Minimal client-side JSCalendar → iCalendar serialization for the popover's "Download .ics".
 * Stalwart v0.16 doesn't serve the `iCalComponent` property, so this is a best-effort
 * re-serialization of what we hold (times exported as UTC instants).
 */
import type { EventInstance } from "../jmap/calendar.ts";
import type { RecRule } from "./recurrence.ts";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(
    /\r?\n/g,
    "\\n",
  );
}

function utcStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function ruleToRrule(rule: RecRule): string {
  const parts = [`FREQ=${(rule.frequency ?? "yearly").toUpperCase()}`];
  if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) {
    parts.push(
      `BYDAY=${
        rule.byDay.map((nd) => `${nd.nthOfPeriod ?? ""}${(nd.day ?? "").toUpperCase()}`).join(",")
      }`,
    );
  }
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.bySetPosition?.length) parts.push(`BYSETPOS=${rule.bySetPosition.join(",")}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${utcStamp(rule.until)}Z`.replace("ZZ", "Z"));
  if (rule.rscale && rule.rscale !== "gregorian") {
    parts.unshift(`RSCALE=${rule.rscale.toUpperCase()}`);
  }
  return parts.join(";");
}

export function eventToIcs(
  ev: EventInstance,
  base?: { uid?: string; recurrenceRules?: RecRule[]; recurrenceRule?: RecRule },
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sundog//JSCalendar export//EN",
    "BEGIN:VEVENT",
    `UID:${esc(base?.uid ?? ev.baseEventId ?? ev.id)}`,
    `DTSTAMP:${utcStamp(new Date().toISOString())}`,
    `DTSTART:${utcStamp(ev.utcStart)}`,
    `DTEND:${utcStamp(ev.utcEnd)}`,
    `SUMMARY:${esc(ev.title || "(untitled)")}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${esc(ev.description)}`);
  const loc = Object.values(ev.locations ?? {})[0];
  if (loc?.name) lines.push(`LOCATION:${esc(loc.name)}`);
  if (ev.status && ev.status !== "confirmed") lines.push(`STATUS:${ev.status.toUpperCase()}`);
  const rules = base?.recurrenceRules ?? (base?.recurrenceRule ? [base.recurrenceRule] : []);
  for (const rule of rules) lines.push(`RRULE:${ruleToRrule(rule)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcs(ev: EventInstance, base?: Parameters<typeof eventToIcs>[1]): void {
  const blob = new Blob([eventToIcs(ev, base)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(ev.title || "event").replace(/[^\w\d-]+/g, "_").slice(0, 40)}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
