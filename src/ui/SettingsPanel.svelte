<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import {
    EXAMPLE_CUSTOM,
    INTL_CALENDARS,
    validateCustomCalendar,
  } from "../lib/altcal.ts";
  import {
    type CustomCalendar,
    persistSettings,
    settings,
  } from "../state/settings.svelte.ts";

  interface Props {
    onclose: () => void;
  }

  const { onclose }: Props = $props();

  let draft = $state("");
  let draftError = $state("");

  function save() {
    persistSettings();
  }

  function addCustom() {
    draftError = "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      draftError = "Not valid JSON.";
      return;
    }
    const problem = validateCustomCalendar(parsed);
    if (problem) {
      draftError = problem;
      return;
    }
    const cal = parsed as CustomCalendar;
    settings.customCalendars = [
      ...settings.customCalendars.filter((c) => c.id !== cal.id),
      cal,
    ];
    settings.secondaryCalendar = `custom:${cal.id}`;
    draft = "";
    save();
  }

  function removeCustom(id: string) {
    settings.customCalendars = settings.customCalendars.filter((c) => c.id !== id);
    if (settings.secondaryCalendar === `custom:${id}`) settings.secondaryCalendar = "none";
    save();
  }

  function insertExample() {
    draft = JSON.stringify(EXAMPLE_CUSTOM, null, 2);
    draftError = "";
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="veil" onclick={onclose}></div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="panel" role="dialog" aria-label="Settings" onkeydown={onKeydown}>
  <header>
    <h2>Settings</h2>
    <button class="btn icon" onclick={onclose} aria-label="Close"><X size={16} /></button>
  </header>

  <div class="body">
    <label class="field">
      <span class="label">Secondary calendar</span>
      <select
        bind:value={settings.secondaryCalendar}
        onchange={save}
      >
        <option value="none">None</option>
        <optgroup label="Traditional">
          {#each INTL_CALENDARS as cal (cal.id)}
            <option value={"ca:" + cal.id}>{cal.name}</option>
          {/each}
        </optgroup>
        {#if settings.customCalendars.length}
          <optgroup label="Custom">
            {#each settings.customCalendars as cal (cal.id)}
              <option value={"custom:" + cal.id}>{cal.name}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
      <span class="hint">Annotates dates across month, week, agenda and event details.</span>
    </label>

    <label class="check">
      <input
        type="checkbox"
        bind:checked={settings.weekNumbers}
        onchange={save}
      />
      ISO week numbers
    </label>

    <label class="check">
      <input
        type="checkbox"
        bind:checked={settings.showDeclined}
        onchange={save}
      />
      Show events you declined (faded)
    </label>

    <label class="field">
      <span class="label">Week view density</span>
      <select bind:value={settings.hourHeight} onchange={save}>
        <option value={36}>Compact</option>
        <option value={48}>Normal</option>
        <option value={64}>Roomy</option>
      </select>
    </label>

    <div class="field">
      <span class="label">Custom calendars (fantasy / conlang / house reckoning)</span>
      {#if settings.customCalendars.length}
        <ul class="customs">
          {#each settings.customCalendars as cal (cal.id)}
            <li>
              <span class="c-name">{cal.name}</span>
              <span class="c-meta">
                {cal.months.length} months · epoch {cal.epoch}
              </span>
              <button class="linkish" onclick={() => removeCustom(cal.id)}>remove</button>
            </li>
          {/each}
        </ul>
      {/if}
      <textarea
        bind:value={draft}
        rows="8"
        spellcheck="false"
        placeholder={'Paste a calendar definition as JSON — or start from the example.\n{"id":"...","name":"...","epoch":"YYYY-MM-DD","months":[{"name":"...","days":30},…],"leap":{"everyYears":4,"month":13,"days":1},"format":"{day} {month}, {year} SE"}'}
      ></textarea>
      {#if draftError}<p class="error">{draftError}</p>{/if}
      <div class="row-btns">
        <button class="btn" onclick={insertExample}>Insert example</button>
        <button class="btn primary" onclick={addCustom} disabled={!draft.trim()}>
          Add calendar
        </button>
      </div>
      <span class="hint">
        Fixed month table + optional leap rule; the epoch date is year 1, day 1. Everything is
        computed locally.
      </span>
    </div>
  </div>
</section>

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 45;
    background: color-mix(in oklab, var(--ink) 14%, transparent);
  }

  .panel {
    position: fixed;
    z-index: 46;
    top: 8vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(30rem, calc(100vw - 1.5rem));
    max-height: 84vh;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .body {
    overflow-y: auto;
    padding: 0.4rem 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.95rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
  }

  select,
  textarea {
    font: inherit;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 0.4rem 0.55rem;
  }

  textarea {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72rem;
    resize: vertical;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
    cursor: pointer;
  }

  .hint {
    font-size: 0.72rem;
    color: var(--ink-faint);
  }

  .customs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .customs li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.84rem;
  }

  .c-name {
    font-weight: 600;
  }

  .c-meta {
    color: var(--ink-faint);
    font-size: 0.72rem;
    flex: 1;
  }

  .linkish {
    color: var(--now);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .linkish:hover {
    text-decoration: underline;
  }

  .error {
    margin: 0;
    color: var(--now);
    font-size: 0.78rem;
  }

  .row-btns {
    display: flex;
    gap: 0.5rem;
  }
</style>
