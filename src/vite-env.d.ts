/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_BASE: string;
  readonly VITE_OAUTH_CLIENT_ID: string;
  readonly VITE_OAUTH_SCOPES?: string;
  readonly VITE_POLL_INTERVAL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
