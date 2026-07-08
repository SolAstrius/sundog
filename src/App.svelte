<script lang="ts">
  import { hasSession } from "./auth/oauth.ts";
  import { navigate, route } from "./lib/router.svelte.ts";
  import Callback from "./ui/Callback.svelte";
  import Login from "./ui/Login.svelte";
  import Shell from "./ui/Shell.svelte";

  const kind = $derived.by(() => {
    if (route.path === "/login") return "login";
    if (route.path.startsWith("/auth/callback")) return "callback";
    return hasSession() ? "shell" : "redirect";
  });

  $effect(() => {
    if (kind === "redirect") navigate("/login", true);
  });
</script>

{#if kind === "login" || kind === "redirect"}
  <Login />
{:else if kind === "callback"}
  <Callback />
{:else}
  <Shell />
{/if}
