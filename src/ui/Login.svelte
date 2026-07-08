<script lang="ts">
  import { startLogin } from "../auth/oauth.ts";
  import { SERVER_BASE } from "../config.ts";

  const serverHost = new URL(SERVER_BASE).host;

  let busy = $state(false);
  let error = $state("");

  async function signIn() {
    busy = true;
    error = "";
    try {
      await startLogin("/");
    } catch (err) {
      busy = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="login">
  <div class="halo" aria-hidden="true"></div>
  <main class="card">
    <div class="brand">
      <span class="mark big" aria-hidden="true"><i></i><i></i><i></i></span>
      <h1>Sundog</h1>
    </div>
    <p class="tagline">Your calendar, on your own server.</p>

    <button class="btn primary go" onclick={signIn} disabled={busy}>
      {busy ? "Redirecting…" : `Sign in with ${serverHost}`}
    </button>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <p class="fineprint">
      Sundog speaks JMAP directly to <strong>{serverHost}</strong> from your browser — no
      middleman, nothing stored anywhere else. Signing in opens your server's own login page.
    </p>
  </main>
</div>

<style>
  .login {
    position: relative;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    overflow: hidden;
  }

  /* Parhelion sky: central glow with two side halos on the 22° arc. */
  .halo {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(
        520px 380px at 50% 30%,
        color-mix(in oklab, var(--amber) 16%, transparent),
        transparent 70%
      ),
      radial-gradient(
        220px 200px at 22% 34%,
        color-mix(in oklab, var(--amber) 9%, transparent),
        transparent 70%
      ),
      radial-gradient(
        220px 200px at 78% 34%,
        color-mix(in oklab, var(--amber) 9%, transparent),
        transparent 70%
      ),
      radial-gradient(
        900px 600px at 50% 110%,
        color-mix(in oklab, var(--sky) 12%, transparent),
        transparent 75%
      );
  }

  .card {
    position: relative;
    width: min(24rem, 100%);
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 2.2rem 2.2rem 1.8rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.4rem;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .mark.big i:nth-child(2) {
    width: 20px;
    height: 20px;
  }

  .mark.big i:nth-child(1),
  .mark.big i:nth-child(3) {
    width: 7px;
    height: 7px;
  }

  h1 {
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .tagline {
    color: var(--ink-soft);
    margin: 0 0 1.4rem;
  }

  .go {
    width: 100%;
    justify-content: center;
    padding: 0.7rem 1rem;
    font-size: 0.95rem;
  }

  .go:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .error {
    color: var(--now);
    font-size: 0.85rem;
    margin: 0.8rem 0 0;
  }

  .fineprint {
    color: var(--ink-faint);
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 1.6rem 0 0;
  }
</style>
