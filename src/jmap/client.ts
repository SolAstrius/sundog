/**
 * Browser JMAP client: session fetch/cache + batched method calls with back-references.
 * Auth comes from auth/oauth.ts per request; a 401 triggers one forced token refresh, then
 * surfaces NotAuthenticatedError for the router to send the user to /login.
 */
import { getAccessToken } from "../auth/oauth.ts";
import { SERVER_BASE } from "../config.ts";
import type { JmapSession } from "../core/jmap/session.ts";

export type MethodCall = [string, Record<string, unknown>, string];
export type MethodResponse = [string, Record<string, unknown>, string];

export class JmapMethodError extends Error {
  constructor(readonly type: string, readonly detail?: string) {
    super(`JMAP method error: ${type}${detail ? ` — ${detail}` : ""}`);
    this.name = "JmapMethodError";
  }
}

const SESSION_TTL_MS = 60_000;

let cachedSession: { session: JmapSession; expiresAt: number } | undefined;

export async function getSession(force = false): Promise<JmapSession> {
  if (!force && cachedSession && Date.now() < cachedSession.expiresAt) {
    return cachedSession.session;
  }
  const res = await authedFetch(`${SERVER_BASE}/jmap/session`);
  if (!res.ok) throw new Error(`JMAP session failed: HTTP ${res.status}`);
  const session = await res.json() as JmapSession;
  cachedSession = { session, expiresAt: Date.now() + SESSION_TTL_MS };
  return session;
}

export function invalidateSession(): void {
  cachedSession = undefined;
}

/** fetch() with the bearer attached; on 401 retries once after a forced token refresh. */
export async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const attempt = async (force: boolean) => {
    const token = await getAccessToken(force);
    return fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  };
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  return res;
}

/** POST one JMAP request (multiple calls, `#arg` back-references welcome). */
export async function request(
  using: string[],
  calls: MethodCall[],
): Promise<MethodResponse[]> {
  const session = await getSession();
  const apiUrl = session.apiUrl || `${SERVER_BASE}/jmap/`;
  const res = await authedFetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
  });
  if (!res.ok) {
    await res.text().catch(() => {});
    if (res.status === 401) invalidateSession();
    throw new Error(`JMAP request failed: HTTP ${res.status}`);
  }
  const body = await res.json() as { methodResponses: MethodResponse[]; sessionState?: string };
  if (body.sessionState && session.state && body.sessionState !== session.state) {
    invalidateSession();
  }
  return body.methodResponses;
}

/** Pull the response for (method, callId); throws JmapMethodError on an `error` response. */
export function expectResponse(
  responses: MethodResponse[],
  method: string,
  callId: string,
): Record<string, unknown> {
  for (const [name, args, id] of responses) {
    if (id !== callId) continue;
    if (name === "error") {
      const a = args as { type?: string; description?: string };
      throw new JmapMethodError(a.type ?? "unknown", a.description);
    }
    if (name === method) return args;
  }
  throw new JmapMethodError("noResponse", `no ${method} response for call ${callId}`);
}
