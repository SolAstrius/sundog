<script lang="ts">
  import { mut, resolveDialog } from "../state/mutations.svelte.ts";

  const d = $derived(mut.dialog);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      resolveDialog(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      resolveDialog(true);
    }
  }

  // Focus the confirm button so Enter/Esc work immediately.
  function autofocus(el: HTMLElement) {
    setTimeout(() => el.focus(), 0);
  }
</script>

{#if d}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="backdrop" onclick={() => resolveDialog(false)}></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_element_to_interactive_role -->
  <section class="dialog" role="alertdialog" aria-label={d.title} onkeydown={onKeydown}>
    <h2>{d.title}</h2>

    {#if d.askScope}
      <div class="scope" role="radiogroup" aria-label="Which events">
        <label>
          <input type="radio" name="scope" value="one" bind:group={d.scope} />
          This event only
        </label>
        <label>
          <input type="radio" name="scope" value="all" bind:group={d.scope} />
          All events in the series
        </label>
      </div>
    {/if}

    {#if d.askNotify}
      <label class="notify">
        <input type="checkbox" bind:checked={d.notify} />
        Email the change to guests
      </label>
    {/if}

    <footer>
      <button class="btn" onclick={() => resolveDialog(false)}>Cancel</button>
      <button
        class="btn primary"
        class:danger={d.danger}
        onclick={() => resolveDialog(true)}
        use:autofocus
      >{d.confirmLabel}</button>
    </footer>
  </section>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.25);
  }

  .dialog {
    position: fixed;
    z-index: 61;
    left: 50%;
    top: 26vh;
    transform: translateX(-50%);
    width: min(21rem, calc(100vw - 24px));
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 1rem 1.1rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h2 {
    margin: 0;
    font-size: 0.98rem;
    font-weight: 700;
  }

  .scope {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .scope label,
  .notify {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .notify {
    color: var(--ink-soft);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
    margin-top: 0.2rem;
  }

  .btn.primary.danger {
    background: var(--now);
    border-color: var(--now);
  }
</style>
