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
import { expectResponse, getSession, type MethodCall, request } from "./client.ts";

const USING_CAL = [CAPABILITIES.core, CAPABILITIES.calendars];

export interface CalendarInfo {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  isSubscribed: boolean;
  isVisible: boolean;
  sortOrder: number;
  description: string | null;
  timeZone: string | null;
  includeInAvailability: string | null;
  myRights: Record<string, boolean> | null;
  defaultAlertsWithTime: Record<string, EventAlert> | null;
  defaultAlertsWithoutTime: Record<string, EventAlert> | null;
}

export interface EventLocation {
  name?: string;
  description?: string;
  relativeTo?: "start" | "end";
  timeZone?: string;
  /** geo: URI. */
  coordinates?: string;
  links?: Record<string, EventLink>;
}

export interface EventLink {
  href?: string;
  /** JMAP managed attachment — download needs auth (see jmap/blob.ts). */
  blobId?: string;
  title?: string;
  rel?: string;
  contentType?: string;
  size?: number;
}

export interface EventParticipant {
  name?: string;
  email?: string;
  calendarAddress?: string;
  sendTo?: Record<string, string>;
  kind?: string;
  roles?: Record<string, true>;
  participationStatus?: string;
  participationComment?: string;
  expectReply?: boolean;
  delegatedTo?: Record<string, true>;
  delegatedFrom?: Record<string, true>;
  scheduleStatus?: string[];
}

export interface EventAlert {
  trigger?: { "@type"?: string; offset?: string; relativeTo?: "start" | "end"; when?: string };
  acknowledged?: string;
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
  locations?: Record<string, EventLocation>;
  virtualLocations?: Record<string, { uri?: string; name?: string; description?: string }>;
  description?: string;
  descriptionContentType?: string;
  participants?: Record<string, EventParticipant>;
  keywords?: Record<string, true>;
  links?: Record<string, EventLink>;
  privacy?: "public" | "private" | "secret";
  duration?: string;
  alerts?: Record<string, EventAlert>;
  useDefaultAlerts?: boolean;
  /** Hybrid organizer shapes (see core/provider/stalwart.ts normalizers). */
  replyTo?: Record<string, string>;
  organizerCalendarAddress?: string;
  created?: string;
  updated?: string;
  sequence?: number;
  categories?: Record<string, true>;
  priority?: number;
  relatedTo?: Record<string, { relation?: Record<string, true> }>;
  localizations?: Record<string, Record<string, unknown>>;
  isOrigin?: boolean;
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
    description: typeof c.description === "string" ? c.description : null,
    timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
    includeInAvailability: typeof c.includeInAvailability === "string"
      ? c.includeInAvailability
      : null,
    myRights: (c.myRights ?? null) as CalendarInfo["myRights"],
    defaultAlertsWithTime: (c.defaultAlertsWithTime ?? null) as
      | Record<string, EventAlert>
      | null,
    defaultAlertsWithoutTime: (c.defaultAlertsWithoutTime ?? null) as
      | Record<string, EventAlert>
      | null,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

// NB: requesting utcStart/utcEnd forbids requesting recurrenceOverrides — we never need them
// for display (expanded instances already have overrides applied).
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
  "description",
  "descriptionContentType",
  "participants",
  "keywords",
  "links",
  "privacy",
  "duration",
  "alerts",
  "useDefaultAlerts",
  "replyTo",
  "organizerCalendarAddress",
  "created",
  "updated",
  "sequence",
  "categories",
  "priority",
  "relatedTo",
  "localizations",
  "isOrigin",
];

/**
 * Expanded instances overlapping (afterLocal, beforeLocal) — LocalDateTime strings interpreted in
 * `timeZone`. One round-trip: query + back-referenced get.
 */
/** maxObjectsInGet — a back-referenced get past this trips `requestTooLarge`. */
const GET_CHUNK = 500;

export async function fetchEventWindow(
  accountId: string,
  afterLocal: string,
  beforeLocal: string,
  timeZone: string,
  limit = 1000,
): Promise<EventInstance[]> {
  const query: MethodCall = [
    "CalendarEvent/query",
    {
      accountId,
      filter: { after: afterLocal, before: beforeLocal },
      sort: [{ property: "start", isAscending: true }],
      expandRecurrences: true,
      timeZone,
      limit,
    },
    "q",
  ];

  // Common case: one round-trip with a back-referenced get (safe while ≤ maxObjectsInGet).
  if (limit <= GET_CHUNK) {
    const responses = await request(USING_CAL, [
      query,
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
    return mapInstances((result.list ?? []) as Array<Record<string, unknown>>);
  }

  // Large windows (year view): query first, then chunked gets.
  const queryResponses = await request(USING_CAL, [query]);
  const ids = (expectResponse(queryResponses, "CalendarEvent/query", "q").ids ?? []) as string[];
  const out: EventInstance[] = [];
  for (let i = 0; i < ids.length; i += GET_CHUNK) {
    const responses = await request(USING_CAL, [
      [
        "CalendarEvent/get",
        {
          accountId,
          ids: ids.slice(i, i + GET_CHUNK),
          properties: INSTANCE_PROPERTIES,
          timeZone,
        },
        "g",
      ],
    ]);
    const result = expectResponse(responses, "CalendarEvent/get", "g");
    out.push(...mapInstances((result.list ?? []) as Array<Record<string, unknown>>));
  }
  return out;
}

function mapInstances(list: Array<Record<string, unknown>>): EventInstance[] {
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
      description: typeof e.description === "string" ? e.description : undefined,
      descriptionContentType: typeof e.descriptionContentType === "string"
        ? e.descriptionContentType
        : undefined,
      participants: e.participants as EventInstance["participants"],
      keywords: e.keywords as EventInstance["keywords"],
      links: e.links as EventInstance["links"],
      privacy: e.privacy as EventInstance["privacy"],
      duration: typeof e.duration === "string" ? e.duration : undefined,
      alerts: e.alerts as EventInstance["alerts"],
      useDefaultAlerts: e.useDefaultAlerts === true,
      replyTo: e.replyTo as EventInstance["replyTo"],
      organizerCalendarAddress: typeof e.organizerCalendarAddress === "string"
        ? e.organizerCalendarAddress
        : undefined,
      created: typeof e.created === "string" ? e.created : undefined,
      updated: typeof e.updated === "string" ? e.updated : undefined,
      sequence: typeof e.sequence === "number" ? e.sequence : undefined,
      categories: e.categories as EventInstance["categories"],
      priority: typeof e.priority === "number" ? e.priority : undefined,
      relatedTo: e.relatedTo as EventInstance["relatedTo"],
      localizations: e.localizations as EventInstance["localizations"],
      isOrigin: e.isOrigin === true ? true : undefined,
    }));
}

export interface EventSearchFilter {
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  attendee?: string;
  owner?: string;
}

/**
 * "собес attendee:daria title:sync" → draft-26 FilterCondition fields. Unprefixed tokens join
 * into `text` (matches title, description, locations, participants server-side).
 */
export function parseSearchQuery(q: string): EventSearchFilter {
  const filter: EventSearchFilter = {};
  const rest: string[] = [];
  for (const token of q.trim().split(/\s+/)) {
    const m = token.match(/^(title|description|location|attendee|owner):(.+)$/);
    if (m) filter[m[1] as keyof EventSearchFilter] = m[2];
    else if (token) rest.push(token);
  }
  if (rest.length) filter.text = rest.join(" ");
  return filter;
}

/**
 * Server-side full-text search over ALL time (no expansion — recurring series match as their
 * base event, whose utcStart is the series start). Newest first.
 */
export async function searchEvents(
  accountId: string,
  filter: EventSearchFilter,
  timeZone: string,
  limit = 50,
): Promise<EventInstance[]> {
  const responses = await request(USING_CAL, [
    [
      "CalendarEvent/query",
      {
        accountId,
        filter,
        sort: [{ property: "start", isAscending: false }],
        limit,
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
  return mapInstances((result.list ?? []) as Array<Record<string, unknown>>);
}

/** Base-event detail for the popover's recurrence section (rules, overrides, relations, uid). */
export interface BaseEventDetails {
  id: string;
  uid?: string;
  timeZone?: string;
  duration?: string;
  title?: string;
  calendarIds?: Record<string, true>;
  color?: string;
  /** RFC 8984 plural shape. */
  // deno-lint-ignore no-explicit-any
  recurrenceRules?: any[];
  // deno-lint-ignore no-explicit-any
  excludedRecurrenceRules?: any[];
  /** JSCalendar-bis singular shape — what Stalwart v0.16 actually serves (verified live). */
  // deno-lint-ignore no-explicit-any
  recurrenceRule?: any;
  // deno-lint-ignore no-explicit-any
  excludedRecurrenceRule?: any;
  recurrenceOverrides?: Record<string, Record<string, unknown>>;
  relatedTo?: Record<string, { relation?: Record<string, true> }>;
  [key: string]: unknown;
}

/**
 * Fetch the stored base object (no property filter ⇒ everything except iCalComponent and the
 * utc* conveniences — which is what permits recurrenceOverrides to be returned).
 */
export async function fetchBaseEvents(
  accountId: string,
  ids: string[],
): Promise<BaseEventDetails[]> {
  if (ids.length === 0) return [];
  const responses = await request(USING_CAL, [
    ["CalendarEvent/get", { accountId, ids }, "g"],
  ]);
  const result = expectResponse(responses, "CalendarEvent/get", "g");
  return (result.list ?? []) as BaseEventDetails[];
}

/** The user's own scheduling addresses (RSVP matching, declined detection). */
export async function fetchIdentityAddresses(accountId: string): Promise<string[]> {
  const responses = await request(USING_CAL, [
    ["ParticipantIdentity/get", { accountId, ids: null }, "g"],
  ]);
  const result = expectResponse(responses, "ParticipantIdentity/get", "g");
  return ((result.list ?? []) as Array<{ calendarAddress?: string }>)
    .map((identity) => identity.calendarAddress)
    .filter((address): address is string => typeof address === "string" && address.length > 0);
}

/** Resolve a JSCalendar uid (relatedTo series links) to an event. */
export async function fetchEventByUid(
  accountId: string,
  uid: string,
  timeZone: string,
): Promise<EventInstance | undefined> {
  const responses = await request(USING_CAL, [
    ["CalendarEvent/query", { accountId, filter: { uid }, limit: 1 }, "q"],
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
  return mapInstances((result.list ?? []) as Array<Record<string, unknown>>)[0];
}

/** Cheap change probe: CalendarEvent state (ids: [] fetches nothing but returns state). */
export async function fetchEventState(accountId: string): Promise<string> {
  const responses = await request(USING_CAL, [
    ["CalendarEvent/get", { accountId, ids: [] }, "s"],
  ]);
  const result = expectResponse(responses, "CalendarEvent/get", "s");
  return String(result.state ?? "");
}
