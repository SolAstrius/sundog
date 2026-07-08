/**
 * Production static server: serves dist/ with an SPA fallback (history-API routes like
 * /week/2026-07-08 resolve to index.html) and a /healthz probe endpoint.
 */
import { serveDir } from "jsr:@std/http@1/file-server";

const PORT = Number(Deno.env.get("PORT") ?? 8080);

const indexHtml = await Deno.readFile("dist/index.html");

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }
  const res = await serveDir(req, { fsRoot: "dist", quiet: true });
  // SPA fallback: unknown extensionless paths get the app shell.
  if (res.status === 404 && !url.pathname.includes(".")) {
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return res;
});
