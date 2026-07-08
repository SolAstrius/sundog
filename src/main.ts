import { mount } from "svelte";
import "./styles/app.css";
import App from "./App.svelte";

async function bootstrap() {
  // Dev-only: visiting /__dev/login pulls the dev server's STALWART_BEARER (vite middleware,
  // see vite.config.ts) into localStorage and reloads at "/" — drives the app without an
  // interactive OAuth login. Both sides exist only under `vite dev`.
  if (import.meta.env.DEV && location.pathname === "/__dev/login") {
    const bearer = (await (await fetch("/__dev/bearer")).text()).trim();
    if (bearer) localStorage.setItem("sundog.devBearer", bearer);
    location.replace("/");
    return;
  }
  mount(App, { target: document.getElementById("app")! });
}

void bootstrap();
