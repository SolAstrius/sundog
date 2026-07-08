/**
 * Calendar reads for M0: calendar list, expanded event windows, cheap change detection.
 *
 * Trap notes (docs/rfc-notes, verified live against Stalwart v0.16.11):
 * - expandRecurrences REQUIRES both `after` and `before`; both are LocalDateTime in the query's
 *   timeZone; `after` compares event END, `before` event START (overlap semantics).
 * - We request utcStart/utcEnd (server-computed instants), which is mutually exclusive with
 *   requesting recurrenceOverrides — fine, display doesn't need overrides.
 * - Expanded instances carry synthetic ids + baseEventId (base events: baseEventId == id).
 */
import { CAPABILITIES } from "../core/jmap/session.ts";
import { expectResponse, getSession, request } from "./client.ts";

const USING_CAL = [CAPABILITIES.core, CAPABILITIES.calendars];

export interface CalendarInfo {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  isSubscribed: boolean;
  isVisible: boolean;
  sortOrder: number;
}

export interface EventInstance {
  id: string;
  baseEventId: string | null;
  recurrenceId?: string;
  title: string;
  /** Server-computed UTCDateTime instants — always present because we request them. */
  utcStart: string;
  utcEnd: string;
  timeZone: string | null;
  showWithoutTime: boolean;
  status: "confirmed" | "cancelled" | "tentative";
  freeBusyStatus?: "free" | "busy";
  calendarIds: Record<string, true>;
  color?: string;
  isDraft: boolean;
  locations?: Record<string, { name?: string }>;
  virtualLocations?: Record<string, { uri?: string; name?: string }>;
}

export interface CalendarAccount {
  accountId: string;
  username: string;
}

/** Resolve the calendar-capable account: primaryAccounts first, then any with the capability. */
export async function resolveCalendarAccount(): Promise<CalendarAccount> {
  const session = await getSession();
  const cap = CAPABILITIES.calendars;
  let accountId: string | undefined = session.primaryAccounts?.[cap];
  if (!accountId) {
    accountId = Object.entries(session.accounts ?? {}).find(
      ([, account]) => account.accountCapabilities?.[cap] !== undefined,
    )?.[0];
  }
  if (!accountId) throw new Error("No JMAP account with calendar capability");
  return { accountId, username: session.username ?? "" };
}

export async function fetchCalendars(accountId: string): Promise<CalendarInfo[]> {
  const responses = await request(USING_CAL, [
    ["Calendar/get", { accountId, ids: null }, "c0"],
  ]);
  const result = expectResponse(responses, "Calendar/get", "c0");
  const list = (result.list ?? []) as Array<Record<string, unknown>>;
  return list.map((c) => ({
    id: String(c.id),
    name: typeof c.name === "string" && c.name ? c.name : "(unnamed)",
    color: typeof c.color === "string" ? c.color : null,
    isDefault: c.isDefault === true,
    isSubscribed: c.isSubscribed !== false,
    isVisible: c.isVisible !== false,
    sortOrder: typeof c.sortOrder === "number" ? c.sortOrder : 0,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

const INSTANCE_PROPERTIES = [
  "id",
  "baseEventId",
  "recurrenceId",
  "title",
  "utcStart",
  "utcEnd",
  "timeZone",
  "showWithoutTime",
  "status",
  "freeBusyStatus",
  "calendarIds",
  "color",
  "isDraft",
  "locations",
  "virtualLocations",
];

/**
 * Expanded instances overlapping (afterLocal, beforeLocal) — LocalDateTime strings interpreted in
 * `timeZone`. One round-trip: query + back-referenced get.
 */
export async function fetchEventWindow(
  accountId: string,
  afterLocal: string,
  beforeLocal: string,
  timeZone: string,
): Promise<EventInstance[]> {
  const responses = await request(USING_CAL, [
    [
      "CalendarEvent/query",
      {
        accountId,
        filter: { after: afterLocal, before: beforeLocal },
        sort: [{ property: "start", isAscending: true }],
        expandRecurrences: true,
        timeZone,
        limit: 1000,
      },
      "q",
    ],
    [
      "CalendarEvent/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" },
        properties: INSTANCE_PROPERTIES,
        timeZone,
      },
      "g",
    ],
  ]);
  const result = expectResponse(responses, "CalendarEvent/get", "g");
  const list = (result.list ?? []) as Array<Record<string, unknown>>;
  return list
    .filter((e) => typeof e.utcStart === "string" && typeof e.utcEnd === "string")
    .map((e) => ({
      id: String(e.id),
      baseEventId: typeof e.baseEventId === "string" ? e.baseEventId : null,
      recurrenceId: typeof e.recurrenceId === "string" ? e.recurrenceId : undefined,
      title: typeof e.title === "string" ? e.title : "",
      utcStart: e.utcStart as string,
      utcEnd: e.utcEnd as string,
      timeZone: typeof e.timeZone === "string" ? e.timeZone : null,
      showWithoutTime: e.showWithoutTime === true,
      status: (e.status as EventInstance["status"]) ?? "confirmed",
      freeBusyStatus: e.freeBusyStatus as EventInstance["freeBusyStatus"],
      calendarIds: (e.calendarIds ?? {}) as Record<string, true>,
      color: typeof e.color === "string" ? e.color : undefined,
      isDraft: e.isDraft === true,
      locations: e.locations as EventInstance["locations"],
      virtualLocations: e.virtualLocations as EventInstance["virtualLocations"],
    }));
}

/** Cheap change probe: CalendarEvent state (ids: [] fetches nothing but returns state). */
export async function fetchEventState(accountId: string): Promise<string> {
  const responses = await request(USING_CAL, [
    ["CalendarEvent/get", { accountId, ids: [] }, "s"],
  ]);
  const result = expectResponse(responses, "CalendarEvent/get", "s");
  return String(result.state ?? "");
}
