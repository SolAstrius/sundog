/**
 * App state (Svelte 5 runes module): session identity, calendars, the current view window and
 * its events, and the change poller (WS/EventSource can't carry a bearer from a browser, so M0
 * polls CalendarEvent state every POLL_INTERVAL_MS and refetches on change / tab focus).
 */
import { NotAuthenticatedError } from "../auth/oauth.ts";
import { POLL_INTERVAL_MS } from "../config.ts";
import { stalwartProvider } from "../core/provider/stalwart.ts";
import type { TypedEvent } from "../core/schemas/jscalendar.ts";
import {
  type CalendarInfo,
  type EventInstance,
  fetchBaseEvents,
  fetchCalendars,
  fetchEventState,
  fetchEventWindow,
  fetchIdentityAddresses,
  resolveCalendarAccount,
} from "../jmap/calendar.ts";
import {
  addDays,
  addMonths,
  BROWSER_TZ,
  dateKey,
  durationToMs,
  monthGridStart,
  parseDateKey,
  startOfDay,
  startOfWeek,
  toLocalDateTime,
  zonedLocalToUtc,
} from "../lib/dates.ts";
import { navigate } from "../lib/router.svelte.ts";
import { settings } from "./settings.svelte.ts";

const normalize = stalwartProvider().normalize;

export type ViewKind = "week" | "month" | "agenda" | "year" | "planner";

export const VIEW_KINDS: ViewKind[] = ["week", "month", "agenda", "year", "planner"];

/** Agenda loads this many days at once and extends by the same amount on scroll. */
export const AGENDA_CHUNK_DAYS = 30;

const HIDDEN_KEY = "sundog.hiddenCalendars";

function loadHidden(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** A cancelled occurrence (override with excluded:true) rendered as a ghost slot. */
export interface GhostSlot {
  baseEventId: string;
  recurrenceId: string;
  title: string;
  utcStart: string;
  utcEnd: string;
  calendarIds: Record<string, true>;
  color?: string;
}

export const app = $state({
  ready: false,
  loading: false,
  error: "",
  accountId: "",
  username: "",
  /** Own scheduling addresses (ParticipantIdentity) — RSVP/declined matching. */
  identities: [] as string[],
  calendars: [] as CalendarInfo[],
  hiddenCalendars: loadHidden(),
  events: [] as EventInstance[],
  ghosts: [] as GhostSlot[],
  view: "week" as ViewKind,
  /** Local date key "YYYY-MM-DD" anchoring the current view. */
  anchor: dateKey(new Date()),
  /** Agenda window length in days (grows via "load more"). */
  agendaDays: AGENDA_CHUNK_DAYS,
  /** Sidebar filters. Empty keyword set = no keyword filtering. */
  filters: {
    keywords: {} as Record<string, true>,
    showTentative: true,
    showCancelled: true,
    showDrafts: true,
    showFree: true,
  },
});

export function toggleKeywordFilter(kw: string): void {
  if (app.filters.keywords[kw]) delete app.filters.keywords[kw];
  else app.filters.keywords[kw] = true;
}

export function toggleCalendar(id: string): void {
  app.hiddenCalendars[id] = !app.hiddenCalendars[id];
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(app.hiddenCalendars));
}

/** The user's own RSVP status on an event (undefined when not an invitee). */
export function ownParticipationStatus(event: EventInstance): string | undefined {
  if (!event.participants || app.identities.length === 0) return undefined;
  const own = normalize.ownParticipant(event as unknown as TypedEvent, app.identities);
  if (!own) return undefined;
  return event.participants[own.participantId]?.participationStatus ?? "needs-action";
}

export function isDeclined(event: EventInstance): boolean {
  return ownParticipationStatus(event) === "declined";
}

/** Visible = at least one containing calendar visible AND the sidebar filters pass. */
export function isEventVisible(event: EventInstance): boolean {
  const ids = Object.keys(event.calendarIds);
  if (ids.length > 0 && !ids.some((id) => !app.hiddenCalendars[id])) return false;
  const f = app.filters;
  if (!f.showTentative && event.status === "tentative") return false;
  if (!f.showCancelled && event.status === "cancelled") return false;
  if (!f.showDrafts && event.isDraft) return false;
  if (!f.showFree && event.freeBusyStatus === "free") return false;
  if (!settings.showDeclined && isDeclined(event)) return false;
  const selected = Object.keys(f.keywords);
  if (selected.length && !selected.some((kw) => event.keywords?.[kw])) return false;
  return true;
}

interface WindowBounds {
  after: string;
  before: string;
  limit?: number;
  startMs: number;
  endMs: number;
}

function boundsFor(view: ViewKind, anchorKey: string, agendaDays: number): WindowBounds {
  const anchorDate = parseDateKey(anchorKey);
  let start: Date;
  let end: Date;
  let limit: number | undefined;
  switch (view) {
    case "month":
      start = monthGridStart(anchorDate);
      end = addDays(start, 42);
      break;
    case "agenda":
      start = startOfDay(anchorDate);
      end = addDays(start, agendaDays);
      break;
    case "planner":
      start = startOfDay(anchorDate);
      end = addDays(start, 1);
      break;
    case "year":
      // maxExpandedQueryDuration is P52W1D (365d) — clamp leap years.
      start = new Date(anchorDate.getFullYear(), 0, 1);
      end = new Date(anchorDate.getFullYear() + 1, 0, 1);
      if ((end.getTime() - start.getTime()) / 86_400_000 > 365) end = addDays(start, 365);
      limit = 2000;
      break;
    default:
      start = startOfWeek(anchorDate);
      end = addDays(start, 7);
  }
  // Overlap semantics: `after` compares event END, `before` event START.
  return {
    after: toLocalDateTime(start),
    before: toLocalDateTime(end),
    limit,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function windowBounds(): WindowBounds {
  return boundsFor(app.view, app.anchor, app.agendaDays);
}

/** The anchor one step away in the current view (shared by header nav and prefetch). */
export function stepAnchor(direction: 1 | -1): Date {
  const anchorDate = parseDateKey(app.anchor);
  switch (app.view) {
    case "month":
      return addMonths(anchorDate, direction);
    case "agenda":
      return addDays(anchorDate, direction * AGENDA_CHUNK_DAYS);
    case "year":
      return new Date(anchorDate.getFullYear() + direction, 0, 1);
    case "planner":
      return addDays(anchorDate, direction);
    default:
      return addDays(anchorDate, direction * 7);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function handleAuthFailure(err: unknown): boolean {
  if (err instanceof NotAuthenticatedError) {
    navigate("/login", true);
    return true;
  }
  return false;
}

let loadSeq = 0;

// Window cache: instant back/forward + idle prefetch of adjacent windows.
const winCache = new Map<string, EventInstance[]>();
const WIN_CACHE_MAX = 10;

function cacheKey(b: WindowBounds): string {
  return `${b.after}|${b.before}|${b.limit ?? 0}`;
}

function cachePut(key: string, events: EventInstance[]): void {
  winCache.delete(key);
  winCache.set(key, events);
  while (winCache.size > WIN_CACHE_MAX) {
    winCache.delete(winCache.keys().next().value as string);
  }
}

export async function loadWindow(): Promise<void> {
  const seq = ++loadSeq;
  const bounds = windowBounds();
  const cached = winCache.get(cacheKey(bounds));
  if (cached) {
    // Instant paint from cache; the fresh fetch below reconciles.
    app.events = cached;
    void loadGhosts(cached, bounds, seq);
  }
  app.loading = true;
  if (seq === loadSeq) app.error = "";
  try {
    const events = await fetchEventWindow(
      app.accountId,
      bounds.after,
      bounds.before,
      BROWSER_TZ,
      bounds.limit,
    );
    cachePut(cacheKey(bounds), events);
    if (seq === loadSeq) {
      app.events = events;
      void loadGhosts(events, bounds, seq);
      schedulePrefetch();
    }
  } catch (err) {
    if (handleAuthFailure(err)) return;
    if (seq === loadSeq) app.error = describeError(err);
  } finally {
    if (seq === loadSeq) app.loading = false;
  }
}

/**
 * Cancelled-occurrence ghosts: overrides with {excluded: true} never come back from expansion,
 * but the base objects list them. Scans bases of recurring instances in the loaded window.
 */
async function loadGhosts(events: EventInstance[], bounds: WindowBounds, seq: number) {
  if (app.view === "year") {
    if (seq === loadSeq) app.ghosts = [];
    return;
  }
  // A series whose only nearby occurrence is the cancelled one has no instance in THIS window —
  // widen the base scan with the prefetched adjacent windows.
  const neighborEvents: EventInstance[] = [];
  for (const direction of [1, -1] as const) {
    const nb = boundsFor(app.view, dateKey(stepAnchor(direction)), app.agendaDays);
    neighborEvents.push(...(winCache.get(cacheKey(nb)) ?? []));
  }
  const baseIds = [
    ...new Set(
      [...events, ...neighborEvents]
        .filter((ev) => ev.recurrenceId && ev.baseEventId)
        .map((ev) => ev.baseEventId!),
    ),
  ].slice(0, 50);
  if (baseIds.length === 0) {
    if (seq === loadSeq) app.ghosts = [];
    return;
  }
  try {
    const bases = await fetchBaseEvents(app.accountId, baseIds);
    const ghosts: GhostSlot[] = [];
    for (const base of bases) {
      const overrides = base.recurrenceOverrides ?? {};
      const durMs = Math.max(durationToMs(base.duration ?? "PT0S"), 15 * 60_000);
      for (const [rid, patch] of Object.entries(overrides)) {
        if (patch?.excluded !== true) continue;
        const start = zonedLocalToUtc(rid, base.timeZone ?? BROWSER_TZ);
        if (start.getTime() < bounds.startMs || start.getTime() >= bounds.endMs) continue;
        ghosts.push({
          baseEventId: base.id,
          recurrenceId: rid,
          title: base.title ?? "(untitled)",
          utcStart: start.toISOString().replace(/\.\d+Z$/, "Z"),
          utcEnd: new Date(start.getTime() + durMs).toISOString().replace(/\.\d+Z$/, "Z"),
          calendarIds: base.calendarIds ?? {},
          color: typeof base.color === "string" ? base.color : undefined,
        });
      }
    }
    if (seq === loadSeq) app.ghosts = ghosts;
  } catch {
    if (seq === loadSeq) app.ghosts = [];
  }
}

let prefetchTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePrefetch(): void {
  if (app.view === "year") return;
  clearTimeout(prefetchTimer);
  const seq = loadSeq;
  prefetchTimer = setTimeout(() => {
    const fetches: Promise<unknown>[] = [];
    for (const direction of [1, -1] as const) {
      const bounds = boundsFor(app.view, dateKey(stepAnchor(direction)), app.agendaDays);
      const key = cacheKey(bounds);
      if (winCache.has(key)) continue;
      fetches.push(
        fetchEventWindow(app.accountId, bounds.after, bounds.before, BROWSER_TZ, bounds.limit)
          .then((events) => cachePut(key, events))
          .catch(() => {}),
      );
    }
    if (fetches.length) {
      // Neighbors may reveal cancelled occurrences whose series has no instance in view.
      void Promise.allSettled(fetches).then(() => {
        if (seq === loadSeq) void loadGhosts(app.events, windowBounds(), seq);
      });
    }
  }, 600);
}

export async function refreshAll(): Promise<void> {
  try {
    app.calendars = await fetchCalendars(app.accountId);
  } catch (err) {
    if (handleAuthFailure(err)) return;
    app.error = describeError(err);
  }
  await loadWindow();
}

export async function initApp(): Promise<void> {
  try {
    const { accountId, username } = await resolveCalendarAccount();
    app.accountId = accountId;
    app.username = username;
    app.calendars = await fetchCalendars(accountId);
    // Identities enable declined-detection; non-fatal when the server withholds them.
    fetchIdentityAddresses(accountId)
      .then((addresses) => (app.identities = addresses))
      .catch(() => {});
    await loadWindow();
    app.ready = true;
    startPolling();
  } catch (err) {
    if (handleAuthFailure(err)) return;
    app.error = describeError(err);
    throw err;
  }
}

/** Route → state. Returns false when the path isn't a calendar route. */
export function applyRoute(path: string): boolean {
  const match = path.match(/^\/(week|month|agenda|year|planner)\/(\d{4}-\d{2}-\d{2})$/);
  if (!match) return false;
  const [, view, anchor] = match;
  const changed = app.view !== view || app.anchor !== anchor;
  if (app.view !== view) app.agendaDays = AGENDA_CHUNK_DAYS;
  app.view = view as ViewKind;
  app.anchor = anchor;
  if (changed && app.ready) void loadWindow();
  return true;
}

/** Agenda "load more": grow the window (bounded by the server's 1-year expand cap). */
export function extendAgenda(): void {
  if (app.agendaDays >= 360 || app.loading) return;
  app.agendaDays += AGENDA_CHUNK_DAYS;
  void loadWindow();
}

export function pathFor(view: ViewKind, anchor: string): string {
  return `/${view}/${anchor}`;
}

// --- change polling -------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastState = "";

async function checkForChanges(): Promise<void> {
  if (document.hidden || !app.accountId) return;
  try {
    const state = await fetchEventState(app.accountId);
    if (lastState && state !== lastState) await refreshAll();
    lastState = state;
  } catch {
    // Transient poll failures are non-events; the next tick retries.
  }
}

function onVisibilityChange(): void {
  if (!document.hidden) void checkForChanges();
}

export function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => void checkForChanges(), POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void checkForChanges();
}

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}
