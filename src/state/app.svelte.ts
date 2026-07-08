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
  startOfWeek,
  toLocalDateTime,
} from "../lib/dates.ts";
import { navigate } from "../lib/router.svelte.ts";

export type ViewKind = "week" | "month";

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
});

export function toggleCalendar(id: string): void {
  app.hiddenCalendars[id] = !app.hiddenCalendars[id];
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(app.hiddenCalendars));
}

/** An event is visible when at least one calendar containing it is visible. */
export function isEventVisible(event: EventInstance): boolean {
  const ids = Object.keys(event.calendarIds);
  if (ids.length === 0) return true;
  return ids.some((id) => !app.hiddenCalendars[id]);
}

function windowBounds(): { after: string; before: string } {
  const anchorDate = parseDateKey(app.anchor);
  const start = app.view === "week" ? startOfWeek(anchorDate) : monthGridStart(anchorDate);
  const end = addDays(start, app.view === "week" ? 7 : 42);
  // Overlap semantics: `after` compares event END, `before` event START.
  return { after: toLocalDateTime(start), before: toLocalDateTime(end) };
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
    const { after, before } = windowBounds();
    const events = await fetchEventWindow(app.accountId, after, before, BROWSER_TZ);
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
  const match = path.match(/^\/(week|month)\/(\d{4}-\d{2}-\d{2})$/);
  if (!match) return false;
  const [, view, anchor] = match;
  const changed = app.view !== view || app.anchor !== anchor;
  app.view = view as ViewKind;
  app.anchor = anchor;
  if (changed && app.ready) void loadWindow();
  return true;
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
