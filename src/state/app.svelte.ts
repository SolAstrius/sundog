/**
 * App state (Svelte 5 runes module): session identity, calendars, the current view window and
 * its events, and the change poller (WS/EventSource can't carry a bearer from a browser, so M0
 * polls CalendarEvent state every POLL_INTERVAL_MS and refetches on change / tab focus).
 */
import { NotAuthenticatedError } from "../auth/oauth.ts";
import { POLL_INTERVAL_MS } from "../config.ts";
import {
  type CalendarInfo,
  type EventInstance,
  fetchCalendars,
  fetchEventState,
  fetchEventWindow,
  resolveCalendarAccount,
} from "../jmap/calendar.ts";
import {
  addDays,
  BROWSER_TZ,
  dateKey,
  monthGridStart,
  parseDateKey,
  startOfDay,
  startOfWeek,
  toLocalDateTime,
} from "../lib/dates.ts";
import { navigate } from "../lib/router.svelte.ts";

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

export const app = $state({
  ready: false,
  loading: false,
  error: "",
  accountId: "",
  username: "",
  calendars: [] as CalendarInfo[],
  hiddenCalendars: loadHidden(),
  events: [] as EventInstance[],
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

/** Visible = at least one containing calendar visible AND the sidebar filters pass. */
export function isEventVisible(event: EventInstance): boolean {
  const ids = Object.keys(event.calendarIds);
  if (ids.length > 0 && !ids.some((id) => !app.hiddenCalendars[id])) return false;
  const f = app.filters;
  if (!f.showTentative && event.status === "tentative") return false;
  if (!f.showCancelled && event.status === "cancelled") return false;
  if (!f.showDrafts && event.isDraft) return false;
  if (!f.showFree && event.freeBusyStatus === "free") return false;
  const selected = Object.keys(f.keywords);
  if (selected.length && !selected.some((kw) => event.keywords?.[kw])) return false;
  return true;
}

function windowBounds(): { after: string; before: string; limit?: number } {
  const anchorDate = parseDateKey(app.anchor);
  let start: Date;
  let end: Date;
  let limit: number | undefined;
  switch (app.view) {
    case "month":
      start = monthGridStart(anchorDate);
      end = addDays(start, 42);
      break;
    case "agenda":
      start = startOfDay(anchorDate);
      end = addDays(start, app.agendaDays);
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
  return { after: toLocalDateTime(start), before: toLocalDateTime(end), limit };
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

export async function loadWindow(): Promise<void> {
  const seq = ++loadSeq;
  app.loading = true;
  if (seq === loadSeq) app.error = "";
  try {
    const { after, before, limit } = windowBounds();
    const events = await fetchEventWindow(app.accountId, after, before, BROWSER_TZ, limit);
    if (seq === loadSeq) app.events = events;
  } catch (err) {
    if (handleAuthFailure(err)) return;
    if (seq === loadSeq) app.error = describeError(err);
  } finally {
    if (seq === loadSeq) app.loading = false;
  }
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
