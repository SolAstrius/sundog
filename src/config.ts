/**
 * Sundog configuration, sourced from Vite .env (defaults in the committed .env; local overrides
 * in .env.local). Fails loudly at startup when a required var is missing rather than producing
 * confusing fetch errors later.
 */

function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required env var ${name} — set it in .env / .env.local`);
  }
  return value;
}

/** JMAP server base URL (no trailing slash). */
export const SERVER_BASE = required("VITE_SERVER_BASE").replace(/\/+$/, "");

/** OAuth public client id (see .env for registration provenance). */
export const OAUTH_CLIENT_ID = required("VITE_OAUTH_CLIENT_ID");

/** offline_access gives us refresh tokens; the PIM scopes gate JMAP data access. */
export const OAUTH_SCOPES = import.meta.env.VITE_OAUTH_SCOPES ??
  [
    "offline_access",
    "urn:ietf:params:oauth:scope:mail",
    "urn:ietf:params:oauth:scope:contacts",
    "urn:ietf:params:oauth:scope:calendars",
  ].join(" ");

/** How often the state poller checks for server-side changes (ms). */
export const POLL_INTERVAL_MS = (() => {
  const raw = Number(import.meta.env.VITE_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 30_000;
})();
