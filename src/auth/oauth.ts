/**
 * OAuth 2.0 authorization-code + PKCE (S256) against Stalwart, as a public client
 * (token_endpoint_auth_method "none"). Tokens live in localStorage; refresh is single-flight.
 *
 * Dev fallback: in `import.meta.env.DEV` only, a bearer placed in localStorage under
 * `sundog.devBearer` short-circuits the whole flow (useful for driving the app without an
 * interactive login). Never honored in production builds.
 */
import { OAUTH_CLIENT_ID, OAUTH_SCOPES, SERVER_BASE } from "../config.ts";

const TOKENS_KEY = "sundog.tokens";
const PKCE_KEY = "sundog.pkce";
const DEV_BEARER_KEY = "sundog.devBearer";

export class NotAuthenticatedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

interface OauthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}

let metadataPromise: Promise<OauthMetadata> | undefined;

function metadata(): Promise<OauthMetadata> {
  metadataPromise ??= fetch(`${SERVER_BASE}/.well-known/oauth-authorization-server`).then(
    async (res) => {
      if (!res.ok) throw new Error(`OAuth metadata failed: HTTP ${res.status}`);
      return await res.json() as OauthMetadata;
    },
  ).catch((err) => {
    metadataPromise = undefined;
    throw err;
  });
  return metadataPromise;
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function redirectUri(): string {
  return `${location.origin}/auth/callback`;
}

function loadTokens(): TokenSet | undefined {
  const raw = localStorage.getItem(TOKENS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    localStorage.removeItem(TOKENS_KEY);
    return undefined;
  }
}

function saveTokenResponse(tok: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}): void {
  const set: TokenSet = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  localStorage.setItem(TOKENS_KEY, JSON.stringify(set));
}

function devBearer(): string | null {
  return import.meta.env.DEV ? localStorage.getItem(DEV_BEARER_KEY) : null;
}

/** True when we hold something worth trying (possibly expired — refresh handles that). */
export function hasSession(): boolean {
  return devBearer() !== null || loadTokens() !== undefined;
}

export function logout(): void {
  localStorage.removeItem(TOKENS_KEY);
}

/** Kick off the redirect to Stalwart's authorization endpoint. Never returns (navigates away). */
export async function startLogin(returnTo?: string): Promise<void> {
  const meta = await metadata();
  const verifier = randomToken();
  const state = randomToken();
  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, state, returnTo: returnTo ?? "/" }),
  );
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  location.assign(url.toString());
}

/** Handle /auth/callback: validate state, exchange the code. Returns the path to navigate to. */
export async function handleCallback(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (error) {
    throw new Error(
      `Sign-in was rejected (${error})${
        params.get("error_description") ? `: ${params.get("error_description")}` : ""
      }`,
    );
  }
  const code = params.get("code");
  const state = params.get("state");
  const rawPkce = sessionStorage.getItem(PKCE_KEY);
  const pkce = rawPkce
    ? JSON.parse(rawPkce) as { verifier: string; state: string; returnTo: string }
    : undefined;
  if (!code || !pkce || state !== pkce.state) {
    throw new Error("Sign-in state didn't match (stale tab?). Start again from the login page.");
  }
  sessionStorage.removeItem(PKCE_KEY);

  const meta = await metadata();
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  saveTokenResponse(await res.json());
  return pkce.returnTo || "/";
}

let refreshPromise: Promise<string> | undefined;

async function refresh(tokens: TokenSet): Promise<string> {
  if (!tokens.refreshToken) {
    logout();
    throw new NotAuthenticatedError("Session expired");
  }
  const meta = await metadata();
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    logout();
    throw new NotAuthenticatedError(`Session refresh failed (HTTP ${res.status})`);
  }
  const body = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  // Stalwart may or may not rotate the refresh token; keep the old one unless replaced.
  saveTokenResponse({ ...body, refresh_token: body.refresh_token ?? tokens.refreshToken });
  return body.access_token;
}

/**
 * Current access token, refreshing when within 60s of expiry. Throws NotAuthenticatedError when
 * there is no recoverable session (caller routes to /login).
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const dev = devBearer();
  if (dev) return dev;

  const tokens = loadTokens();
  if (!tokens) throw new NotAuthenticatedError();
  if (!forceRefresh && Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;

  refreshPromise ??= refresh(tokens).finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}
