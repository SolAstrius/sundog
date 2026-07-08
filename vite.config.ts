import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Dev-only helper: serves the STALWART_BEARER from the dev server's environment at
 * /__dev/bearer so a local session can be bootstrapped without an interactive OAuth login
 * (see auth/oauth.ts devBearer). configureServer never runs in production builds.
 */
function devBearer(): Plugin {
  return {
    name: "sundog-dev-bearer",
    configureServer(server) {
      server.middlewares.use("/__dev/bearer", (_req, res) => {
        res.setHeader("content-type", "text/plain");
        res.end(globalThis.process?.env?.STALWART_BEARER ?? "");
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), devBearer()],
  server: {
    // Loopback IP (not localhost): the registered OAuth redirect is http://127.0.0.1/auth/callback
    // and Stalwart matches loopback literally per RFC 8252.
    host: "127.0.0.1",
    port: 5173,
  },
});
