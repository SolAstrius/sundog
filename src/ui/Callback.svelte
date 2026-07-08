<script lang="ts">
  import { handleCallback } from "../auth/oauth.ts";
  import { navigate } from "../lib/router.svelte.ts";

  let error = $state("");

  $effect(() => {
    handleCallback()
      .then((returnTo) => navigate(returnTo, true))
      .catch((err) => {
        error = err instanceof Error ? err.message : String(err);
      });
  });
</script>

<div class="callback">
  {#if error}
    <div class="box" role="alert">
      <h1>Sign-in didn't complete</h1>
      <p>{error}</p>
      <button class="btn primary" onclick={() => navigate("/login", true)}>
        Back to sign-in
      </button>
    </div>
  {:else}
    <div class="box">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <p>Completing sign-in…</p>
    </div>
  {/if}
</div>

<style>
  .callback {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
  }

  .box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.8rem;
    text-align: center;
    max-width: 26rem;
  }

  h1 {
    font-size: 1.2rem;
    margin: 0;
  }

  p {
    color: var(--ink-soft);
    margin: 0;
  }
</style>
