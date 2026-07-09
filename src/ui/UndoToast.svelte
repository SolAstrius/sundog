<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { dismissToast, mut, undoLast } from "../state/mutations.svelte.ts";

  const toast = $derived(mut.toast);

  async function undo(): Promise<void> {
    dismissToast();
    await undoLast();
  }
</script>

{#if toast}
  <div class="toast" class:error={toast.kind === "error"} role="status">
    <span class="text">{toast.text}</span>
    {#if toast.undoable && mut.undoDepth > 0}
      <button class="undo" onclick={undo}>Undo</button>
    {/if}
    <button class="dismiss" onclick={dismissToast} aria-label="Dismiss">
      <X size={13} />
    </button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 1.4rem;
    transform: translateX(-50%);
    z-index: 55;
    display: flex;
    align-items: center;
    gap: 0.7rem;
    background: var(--ink);
    color: var(--ground);
    border-radius: 9px;
    padding: 0.55rem 0.9rem;
    box-shadow: var(--shadow);
    font-size: 0.84rem;
    max-width: min(34rem, calc(100vw - 24px));
  }

  .toast.error {
    background: color-mix(in oklab, var(--now) 82%, black);
    color: white;
  }

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .undo {
    color: var(--amber);
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0.1rem 0.3rem;
  }

  .undo:hover {
    text-decoration: underline;
  }

  .toast.error .undo {
    color: white;
  }

  .dismiss {
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
  }

  .dismiss:hover {
    opacity: 1;
  }
</style>
