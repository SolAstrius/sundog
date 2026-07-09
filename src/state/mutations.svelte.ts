/**
 * M1 mutability (runes module): optimistic writes with an inverse-op undo stack.
 *
 * Every op has one shape: snapshot → optimistic apply to app.events → server write →
 * loadWindow() reconcile (rollback + error toast on failure). Writes always target base ids
 * (synthetic-id /set is rejected by Stalwart, stalwart#2923); "just this occurrence" edits
 * merge into the base event's recurrenceOverrides client-side, because a deep patch into a
 * missing override key is invalidPatch and updateScope/destroyScope do not exist.
 *
 * The scope ("this event" / "all events") and "notify guests" (sendSchedulingMessages)
 * questions are asked here via a promise-based dialog so drag, editor, and delete all
 * surface the same honest choices.
 */
import { stalwartProvider } from "../core/provider/stalwart.ts";
import type { TypedEvent } from "../core/schemas/jscalendar.ts";
import { type BaseEventDetails, type EventInstance, fetchBaseEvents } from "../jmap/calendar.ts";
import { createEvent, destroyEvent, updateEvent } from "../jmap/write.ts";
import {
  BROWSER_TZ,
  dateKey,
  msToDuration,
  shiftLocalDateTime,
  utcToZonedLocal,
} from "../lib/dates.ts";
import { app, invalidateWinCache, loadWindow } from "./app.svelte.ts";

const normalize = stalwartProvider().normalize;

// --- ui state --------------------------------------------------------------------------------

export interface WriteChoice {
  scope: "one" | "all";
  notify: boolean;
}

export interface WriteDialog {
  title: string;
  askScope: boolean;
  askNotify: boolean;
  danger: boolean;
  confirmLabel: string;
  /** Bound by the dialog component. */
  scope: "one" | "all";
  notify: boolean;
  resolve: (choice: WriteChoice | undefined) => void;
}

export const mut = $state({
  busy: false,
  toast: undefined as { text: string; kind: "ok" | "error"; undoable: boolean } | undefined,
  dialog: undefined as WriteDialog | undefined,
  undoDepth: 0,
  /** Instance ids being dragged/written — views can dim them. */
  pendingIds: {} as Record<string, true>,
});

function askWrite(
  opts: Omit<WriteDialog, "resolve" | "scope" | "notify">,
): Promise<WriteChoice | undefined> {
  return new Promise((resolve) => {
    mut.dialog = { ...opts, scope: "one", notify: true, resolve };
  });
}

/** Called by the dialog component. */
export function resolveDialog(confirmed: boolean): void {
  const d = mut.dialog;
  if (!d) return;
  mut.dialog = undefined;
  d.resolve(
    confirmed
      ? { scope: d.askScope ? d.scope : "one", notify: d.askNotify && d.notify }
      : undefined,
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string, kind: "ok" | "error" = "ok", undoable = false): void {
  mut.toast = { text, kind, undoable };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (mut.toast = undefined), kind === "error" ? 10_000 : 7_000);
}

export function dismissToast(): void {
  clearTimeout(toastTimer);
  mut.toast = undefined;
}

// --- undo ------------------------------------------------------------------------------------

interface UndoOp {
  label: string;
  run: () => Promise<void>;
}

const undoStack: UndoOp[] = [];

function pushUndo(op: UndoOp): void {
  undoStack.push(op);
  if (undoStack.length > 30) undoStack.shift();
  mut.undoDepth = undoStack.length;
}

export async function undoLast(): Promise<void> {
  const op = undoStack.pop();
  mut.undoDepth = undoStack.length;
  if (!op || mut.busy) return;
  mut.busy = true;
  try {
    await op.run();
    invalidateWinCache();
    await loadWindow();
    showToast(`Undone: ${op.label.toLowerCase()}`);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  } finally {
    mut.busy = false;
  }
}

// --- guards ----------------------------------------------------------------------------------

export function calendarWritable(calId: string): boolean {
  const cal = app.calendars.find((c) => c.id === calId);
  if (!cal) return true;
  return !cal.myRights || cal.myRights.mayWriteAll !== false;
}

/**
 * May the user change shared (non-per-user) properties? Invited copies (isOrigin false) are
 * organizer-owned — clients MUST NOT edit their core props (RSVP is the M2 verb for those).
 */
export function eventWritable(ev: EventInstance): boolean {
  if (ev.participants && ev.isOrigin === false) return false;
  const ids = Object.keys(ev.calendarIds);
  return ids.length === 0 || ids.some(calendarWritable);
}

function hasOtherParticipants(ev: EventInstance): boolean {
  if (!ev.participants) return false;
  const own = normalize.ownParticipant(ev as unknown as TypedEvent, app.identities);
  return Object.keys(ev.participants).length > (own ? 1 : 0);
}

/**
 * True for an expanded instance of a real series. (A standalone stored occurrence fetched
 * directly has recurrenceId but id === baseEventId and takes the direct-write path; the
 * expanded-window copy of one is indistinguishable from a series instance — acceptable edge,
 * the override patch still renders correctly.)
 */
function isOccurrence(ev: EventInstance): boolean {
  return !!ev.recurrenceId && !!ev.baseEventId && ev.baseEventId !== ev.id;
}

function baseIdOf(ev: EventInstance): string {
  return ev.baseEventId ?? ev.id;
}

async function fetchBase(id: string): Promise<BaseEventDetails> {
  const [base] = await fetchBaseEvents(app.accountId, [id]);
  if (!base) throw new Error("Event no longer exists on the server");
  return base;
}

async function confirmWrite(
  ev: EventInstance,
  verb: "Move" | "Resize" | "Save" | "Delete",
): Promise<WriteChoice | undefined> {
  const askScope = isOccurrence(ev);
  const askNotify = hasOtherParticipants(ev);
  if (!askScope && !askNotify) return { scope: "one", notify: false };
  return await askWrite({
    title: askScope ? `${verb} recurring event` : `${verb} event`,
    askScope,
    askNotify,
    danger: verb === "Delete",
    confirmLabel: verb,
  });
}

// --- shared plumbing ---------------------------------------------------------------------------

const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const startMsOf = (ev: EventInstance) => new Date(ev.utcStart).getTime();
const endMsOf = (ev: EventInstance) => new Date(ev.utcEnd).getTime();

function markPending(ids: string[], on: boolean): void {
  const next = { ...mut.pendingIds };
  for (const id of ids) {
    if (on) next[id] = true;
    else delete next[id];
  }
  mut.pendingIds = next;
}

/** Optimistic apply already done by the caller; this runs the write and reconciles. */
async function commit(
  okText: string,
  snapshot: EventInstance[],
  pending: string[],
  work: () => Promise<UndoOp | undefined>,
): Promise<boolean> {
  mut.busy = true;
  markPending(pending, true);
  try {
    const undo = await work();
    if (undo) pushUndo(undo);
    invalidateWinCache();
    await loadWindow();
    showToast(okText, "ok", !!undo);
    return true;
  } catch (err) {
    app.events = snapshot;
    showToast(err instanceof Error ? err.message : String(err), "error");
    return false;
  } finally {
    markPending(pending, false);
    mut.busy = false;
  }
}

/** Previous values for `keys` as an inverse patch (missing before ⇒ null = remove). */
function inversePatch(base: BaseEventDetails, keys: string[]): Record<string, unknown> {
  const inverse: Record<string, unknown> = {};
  for (const key of keys) {
    inverse[key] = (base as Record<string, unknown>)[key] ?? null;
  }
  return inverse;
}

function overrideUndo(
  baseId: string,
  rid: string,
  prev: Record<string, unknown> | undefined,
  label: string,
): UndoOp {
  return {
    label,
    run: () => updateEvent(app.accountId, baseId, { [`recurrenceOverrides/${rid}`]: prev ?? null }),
  };
}

// --- ops ---------------------------------------------------------------------------------------

/**
 * Drag verb: shift an instance by wall-clock deltaMs and/or set a new duration.
 * Scope + notify are asked when relevant. No-ops return true silently.
 */
export async function rescheduleInstance(
  ev: EventInstance,
  deltaMs: number,
  durMs?: number,
): Promise<boolean> {
  if (!eventWritable(ev)) {
    showToast("Read-only: only the organizer can change this event", "error");
    return false;
  }
  const oldDurMs = endMsOf(ev) - startMsOf(ev);
  if (deltaMs === 0 && (durMs === undefined || durMs === oldDurMs)) return true;

  const verb = durMs !== undefined && deltaMs === 0 ? "Resize" : "Move";
  const choice = await confirmWrite(ev, verb);
  if (!choice) return false;

  const baseId = baseIdOf(ev);
  const scopeAll = choice.scope === "all";
  const targets = scopeAll
    ? app.events.filter((e) => baseIdOf(e) === baseId).map((e) => e.id)
    : [ev.id];

  const snapshot = app.events;
  const targetSet = new Set(targets);
  app.events = app.events.map((e) => {
    if (!targetSet.has(e.id)) return e;
    const start = startMsOf(e) + deltaMs;
    const dur = durMs ?? endMsOf(e) - startMsOf(e);
    return { ...e, utcStart: isoZ(start), utcEnd: isoZ(start + dur) };
  });

  const okText = verb === "Resize" ? "Event resized" : scopeAll ? "Series moved" : "Event moved";
  return await commit(okText, snapshot, targets, async () => {
    const base = await fetchBase(baseId);
    if (isOccurrence(ev) && !scopeAll) {
      // Occurrence scope: merge into the base's recurrenceOverrides (never a deep patch —
      // the override key may not exist yet).
      const rid = ev.recurrenceId!;
      const prev = base.recurrenceOverrides?.[rid];
      const tz = base.timeZone ?? BROWSER_TZ;
      const override: Record<string, unknown> = {
        ...(prev ?? {}),
        start: utcToZonedLocal(new Date(startMsOf(ev) + deltaMs), tz),
        duration: msToDuration(durMs ?? oldDurMs),
      };
      await updateEvent(
        app.accountId,
        baseId,
        { [`recurrenceOverrides/${rid}`]: override },
        choice.notify,
      );
      return overrideUndo(baseId, rid, prev, verb);
    }
    // Whole event / whole series: wall-clock shift of the stored start.
    if (!base.start) throw new Error("Event has no start on the server");
    const patch: Record<string, unknown> = {};
    if (deltaMs !== 0) patch.start = shiftLocalDateTime(base.start, deltaMs);
    if (durMs !== undefined) patch.duration = msToDuration(durMs);
    const inverse = inversePatch(base, Object.keys(patch));
    await updateEvent(app.accountId, baseId, patch, choice.notify);
    return {
      label: verb,
      run: () => updateEvent(app.accountId, baseId, inverse),
    };
  });
}

export interface EditorInput {
  title: string;
  calendarId: string;
  allDay: boolean;
  /** Browser-local instants from the form (endMs exclusive; all-day: local midnights). */
  startMs: number;
  endMs: number;
  description: string;
  locationName: string;
  /** geo: URI from the editor's map picker; "" = no pin. */
  locationCoordinates: string;
}

function locationsFor(input: EditorInput): Record<string, unknown> | undefined {
  if (!input.locationName.trim() && !input.locationCoordinates) return undefined;
  const loc: Record<string, unknown> = { "@type": "Location" };
  if (input.locationName.trim()) loc.name = input.locationName.trim();
  if (input.locationCoordinates) loc.coordinates = input.locationCoordinates;
  return { l1: loc };
}

/** Create a new event from the editor. */
export async function createFromEditor(input: EditorInput): Promise<boolean> {
  if (!calendarWritable(input.calendarId)) {
    showToast("That calendar is read-only for you", "error");
    return false;
  }
  const durMs = input.endMs - input.startMs;
  const props: Record<string, unknown> = {
    title: input.title.trim(),
    calendarIds: { [input.calendarId]: true },
    useDefaultAlerts: true,
  };
  if (input.allDay) {
    props.start = `${dateKey(new Date(input.startMs))}T00:00:00`;
    props.duration = `P${Math.max(1, Math.round(durMs / 86_400_000))}D`;
    props.showWithoutTime = true;
  } else {
    props.start = utcToZonedLocal(new Date(input.startMs), BROWSER_TZ);
    props.timeZone = BROWSER_TZ;
    props.duration = msToDuration(durMs);
  }
  if (input.description.trim()) props.description = input.description.trim();
  const locations = locationsFor(input);
  if (locations) props.locations = locations;

  const temp: EventInstance = {
    id: `temp-${Date.now()}`,
    baseEventId: null,
    title: input.title.trim(),
    utcStart: isoZ(input.startMs),
    utcEnd: isoZ(input.endMs),
    timeZone: input.allDay ? null : BROWSER_TZ,
    showWithoutTime: input.allDay,
    status: "confirmed",
    calendarIds: { [input.calendarId]: true },
    isDraft: false,
  };
  const snapshot = app.events;
  app.events = [...app.events, temp];

  return await commit("Event created", snapshot, [temp.id], async () => {
    const created = await createEvent(app.accountId, props);
    return {
      label: "Create",
      run: () => destroyEvent(app.accountId, created.id),
    };
  });
}

/** Save editor changes to an existing event. */
export async function saveFromEditor(ev: EventInstance, input: EditorInput): Promise<boolean> {
  if (!eventWritable(ev)) {
    showToast("Read-only: only the organizer can change this event", "error");
    return false;
  }
  const origStartMs = startMsOf(ev);
  const origEndMs = endMsOf(ev);
  const origAllDay = ev.showWithoutTime;
  const origCalId = Object.keys(ev.calendarIds)[0] ?? "";
  const origLoc = Object.values(ev.locations ?? {})[0];
  const origLocName = origLoc?.name ?? "";
  const origLocCoords = origLoc?.coordinates ?? "";

  const timeChanged = input.startMs !== origStartMs || input.endMs !== origEndMs ||
    input.allDay !== origAllDay;
  const titleChanged = input.title.trim() !== (ev.title ?? "");
  const descChanged = input.description.trim() !== (ev.description ?? "").trim();
  const locChanged = input.locationName.trim() !== origLocName ||
    input.locationCoordinates !== origLocCoords;
  const calChanged = input.calendarId !== origCalId && input.calendarId !== "";
  if (!timeChanged && !titleChanged && !descChanged && !locChanged && !calChanged) return true;

  if (calChanged && !calendarWritable(input.calendarId)) {
    showToast("That calendar is read-only for you", "error");
    return false;
  }

  const choice = await confirmWrite(ev, "Save");
  if (!choice) return false;

  const baseId = baseIdOf(ev);
  const scopeAll = choice.scope === "all";
  const occurrenceWrite = isOccurrence(ev) && !scopeAll;
  const durMs = input.endMs - input.startMs;

  // Optimistic: patch this instance (scope=all time shifts also hit the siblings).
  const snapshot = app.events;
  const deltaMs = input.startMs - origStartMs;
  app.events = app.events.map((e) => {
    if (e.id === ev.id) {
      return {
        ...e,
        title: input.title.trim(),
        utcStart: isoZ(input.startMs),
        utcEnd: isoZ(input.endMs),
        showWithoutTime: input.allDay,
        description: input.description.trim() || undefined,
        calendarIds: { [input.calendarId]: true },
      };
    }
    if (scopeAll && timeChanged && baseIdOf(e) === baseId) {
      const start = startMsOf(e) + deltaMs;
      return { ...e, utcStart: isoZ(start), utcEnd: isoZ(start + durMs) };
    }
    return e;
  });

  return await commit("Saved", snapshot, [ev.id], async () => {
    const base = await fetchBase(baseId);

    if (occurrenceWrite) {
      const rid = ev.recurrenceId!;
      const prev = base.recurrenceOverrides?.[rid];
      const tz = base.timeZone ?? BROWSER_TZ;
      const override: Record<string, unknown> = { ...(prev ?? {}) };
      if (titleChanged) override.title = input.title.trim();
      if (descChanged) override.description = input.description.trim() || null;
      if (timeChanged) {
        override.start = utcToZonedLocal(new Date(input.startMs), tz);
        override.duration = msToDuration(durMs);
      }
      if (locChanged) override.locations = locationsFor(input) ?? null;
      await updateEvent(
        app.accountId,
        baseId,
        { [`recurrenceOverrides/${rid}`]: override },
        choice.notify,
      );
      return overrideUndo(baseId, rid, prev, "Edit");
    }

    const patch: Record<string, unknown> = {};
    if (titleChanged) patch.title = input.title.trim();
    if (descChanged) patch.description = input.description.trim() || null;
    if (calChanged) patch.calendarIds = { [input.calendarId]: true };
    if (locChanged) {
      const keys = Object.keys(base.locations ?? {});
      if (!input.locationName.trim() && !input.locationCoordinates) patch.locations = null;
      else if (keys.length > 0) {
        patch[`locations/${keys[0]}/name`] = input.locationName.trim() || null;
        patch[`locations/${keys[0]}/coordinates`] = input.locationCoordinates || null;
      } else patch.locations = locationsFor(input);
    }
    if (timeChanged) {
      if (!base.start) throw new Error("Event has no start on the server");
      if (isOccurrence(ev)) {
        // Whole series from an occurrence's editor: apply the wall-clock delta to the series.
        patch.start = shiftLocalDateTime(base.start, deltaMs);
        patch.duration = msToDuration(durMs);
      } else if (input.allDay) {
        patch.start = `${dateKey(new Date(input.startMs))}T00:00:00`;
        patch.duration = `P${Math.max(1, Math.round(durMs / 86_400_000))}D`;
        patch.showWithoutTime = true;
        patch.timeZone = null;
      } else {
        const tz = origAllDay ? BROWSER_TZ : base.timeZone ?? BROWSER_TZ;
        patch.start = utcToZonedLocal(new Date(input.startMs), tz);
        patch.duration = msToDuration(durMs);
        patch.showWithoutTime = false;
        if (origAllDay) patch.timeZone = BROWSER_TZ;
      }
    }
    // locations deep-pointer keys invert against the whole map for simplicity.
    const inverseKeys = Object.keys(patch).map((k) => k.split("/")[0]);
    const inverse = inversePatch(base, [...new Set(inverseKeys)]);
    await updateEvent(app.accountId, baseId, patch, choice.notify);
    return {
      label: "Edit",
      run: () => updateEvent(app.accountId, baseId, inverse),
    };
  });
}

/** Server-set / server-owned properties stripped before an undo-recreate. */
const RECREATE_STRIP = [
  "id",
  "baseEventId",
  "created",
  "updated",
  "sequence",
  "isOrigin",
  "organizerCalendarAddress",
  "utcStart",
  "utcEnd",
];

export async function deleteInstance(ev: EventInstance): Promise<boolean> {
  if (!eventWritable(ev)) {
    showToast("Read-only: only the organizer can delete this event", "error");
    return false;
  }
  const choice = await confirmWrite(ev, "Delete");
  if (!choice) return false;

  const baseId = baseIdOf(ev);
  const scopeOne = isOccurrence(ev) && choice.scope !== "all";
  const snapshot = app.events;
  app.events = scopeOne
    ? app.events.filter((e) => e.id !== ev.id)
    : app.events.filter((e) => baseIdOf(e) !== baseId);

  const okText = scopeOne ? "Occurrence deleted" : "Event deleted";
  return await commit(okText, snapshot, [], async () => {
    if (scopeOne) {
      const base = await fetchBase(baseId);
      const rid = ev.recurrenceId!;
      const prev = base.recurrenceOverrides?.[rid];
      await updateEvent(
        app.accountId,
        baseId,
        { [`recurrenceOverrides/${rid}`]: { excluded: true } },
        choice.notify,
      );
      return overrideUndo(baseId, rid, prev, "Delete occurrence");
    }
    // Snapshot first so undo can recreate (new id, same uid — series relations survive).
    const base = await fetchBase(baseId);
    const recreate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      if (!RECREATE_STRIP.includes(key) && value !== null) recreate[key] = value;
    }
    await destroyEvent(app.accountId, baseId, choice.notify);
    return {
      label: "Delete",
      run: async () => {
        await createEvent(app.accountId, recreate);
      },
    };
  });
}
