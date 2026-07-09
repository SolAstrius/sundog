/**
 * CalendarEvent/set for M1 writes.
 *
 * Trap notes (docs/rfc-notes, probed live against Stalwart v0.16.11 on 2026-07-09):
 * - Writes ALWAYS target base ids. `/set` on a synthetic instance id is rejected upstream
 *   ("not yet supported", stalwart#2923) — occurrence-scoped edits patch the base event's
 *   `recurrenceOverrides` instead (callers merge client-side; deep patches into a missing
 *   override key are `invalidPatch`).
 * - `sendSchedulingMessages` (spec default false) is the only extra /set argument; anything
 *   else (updateScope et al.) is silently ignored by the server.
 * - Null property value in create/update = omit/remove.
 */
import { CAPABILITIES } from "../core/jmap/session.ts";
import { expectResponse, request } from "./client.ts";

const USING_CAL = [CAPABILITIES.core, CAPABILITIES.calendars];

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export class EventWriteError extends Error {
  constructor(readonly verb: "create" | "update" | "destroy", readonly setError: SetError) {
    super(describeSetError(verb, setError));
    this.name = "EventWriteError";
  }
}

export function describeSetError(verb: string, err: SetError): string {
  const what = err.type === "forbidden"
    ? "you don't have permission"
    : err.type === "invalidProperties"
    ? `invalid ${(err.properties ?? []).join(", ") || "properties"}`
    : err.type === "noSupportedScheduleMethods"
    ? "a participant can't receive invitations"
    : err.type;
  return `Couldn't ${verb} the event: ${err.description ?? what}`;
}

export interface EventWrite {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: string[];
}

export interface EventSetResult {
  /** creation id → server-set properties (id, uid, …). */
  created: Record<string, { id: string } & Record<string, unknown>>;
  newState?: string;
}

/** One CalendarEvent/set. Throws EventWriteError on the first per-object failure. */
export async function setEvents(
  accountId: string,
  write: EventWrite,
  sendSchedulingMessages = false,
): Promise<EventSetResult> {
  const responses = await request(USING_CAL, [
    ["CalendarEvent/set", { accountId, ...write, sendSchedulingMessages }, "s"],
  ]);
  const result = expectResponse(responses, "CalendarEvent/set", "s");

  for (
    const [verb, key] of [
      ["create", "notCreated"],
      ["update", "notUpdated"],
      ["destroy", "notDestroyed"],
    ] as const
  ) {
    const failures = result[key] as Record<string, SetError> | null | undefined;
    const first = failures && Object.values(failures)[0];
    if (first) throw new EventWriteError(verb, first);
  }

  return {
    created: (result.created ?? {}) as EventSetResult["created"],
    newState: typeof result.newState === "string" ? result.newState : undefined,
  };
}

/** Create one event; returns the server-set properties (id, uid, …). */
export async function createEvent(
  accountId: string,
  properties: Record<string, unknown>,
  sendSchedulingMessages = false,
): Promise<{ id: string } & Record<string, unknown>> {
  const result = await setEvents(
    accountId,
    { create: { new1: properties } },
    sendSchedulingMessages,
  );
  const created = result.created.new1;
  if (!created?.id) throw new Error("Server accepted the create but returned no id");
  return created;
}

/** Patch one event (base id only — see module header). */
export async function updateEvent(
  accountId: string,
  id: string,
  patch: Record<string, unknown>,
  sendSchedulingMessages = false,
): Promise<void> {
  await setEvents(accountId, { update: { [id]: patch } }, sendSchedulingMessages);
}

/** Destroy one event (base id only — destroying a synthetic id is rejected by Stalwart). */
export async function destroyEvent(
  accountId: string,
  id: string,
  sendSchedulingMessages = false,
): Promise<void> {
  await setEvents(accountId, { destroy: [id] }, sendSchedulingMessages);
}
