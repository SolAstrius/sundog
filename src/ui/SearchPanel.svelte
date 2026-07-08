<script lang="ts">
  import SearchIcon from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import { type EventInstance, parseSearchQuery, searchEvents } from "../jmap/calendar.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import { BROWSER_TZ, dateKey } from "../lib/dates.ts";
  import { fmtDayLong, fmtTimeInZone } from "../lib/format.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { app, pathFor } from "../state/app.svelte.ts";
  import { openEvent } from "./popover.svelte.ts";

  interface Props {
    onclose: () => void;
  }

  const { onclose }: Props = $props();

  let query = $state("");
  let results = $state<EventInstance[]>([]);
  let searching = $state(false);
  let searched = $state(false);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    input?.focus();
  });

  const colorMap = $derived(buildColorMap(app.calendars));

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;

  function onInput() {
    clearTimeout(debounce);
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      searched = false;
      return;
    }
    debounce = setTimeout(() => void run(q), 300);
  }

  async function run(q: string) {
    const seq = ++searchSeq;
    searching = true;
    try {
      const found = await searchEvents(app.accountId, parseSearchQuery(q), BROWSER_TZ);
      if (seq === searchSeq) {
        results = found;
        searched = true;
      }
    } catch {
      if (seq === searchSeq) {
        results = [];
        searched = true;
      }
    } finally {
      if (seq === searchSeq) searching = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  }

  function show(ev: EventInstance, el: EventTarget | null) {
    openEvent(ev, eventColor(ev, colorMap), el as Element);
  }

  function goTo(ev: EventInstance) {
    navigate(pathFor("week", dateKey(new Date(ev.utcStart))));
    onclose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="veil" onclick={onclose}></div>
<div class="search" role="dialog" aria-label="Search events">
  <div class="bar">
    <SearchIcon size={16} />
    <input
      bind:this={input}
      bind:value={query}
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="Search events…  (title: attendee: owner: location: prefixes work)"
      spellcheck="false"
    />
    {#if searching}<span class="spin" aria-label="Searching"></span>{/if}
    <button class="btn icon" onclick={onclose} aria-label="Close search"><X size={15} /></button>
  </div>
  {#if results.length}
    <ul class="results">
      {#each results as ev (ev.id)}
        {@const color = eventColor(ev, colorMap)}
        <li>
          <button class="hit" style:--ev={color} onclick={(e) => show(ev, e.currentTarget)}>
            <span class="dot" aria-hidden="true"></span>
            <span class="date">{fmtDayLong(new Date(ev.utcStart))}</span>
            <span class="time">
              {ev.showWithoutTime ? "all day" : fmtTimeInZone(new Date(ev.utcStart), BROWSER_TZ)}
            </span>
            <span class="title" class:cancelled={ev.status === "cancelled"}>
              {ev.title || "(untitled)"}
            </span>
            <span
              class="go"
              role="link"
              tabindex="-1"
              onclick={(e) => {
                e.stopPropagation();
                goTo(ev);
              }}
              onkeydown={(e) => e.key === "Enter" && goTo(ev)}
            >week ›</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if searched && !searching}
    <p class="none">No events match. Recurring series match by their base event.</p>
  {/if}
</div>

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 45;
    background: color-mix(in oklab, var(--ink) 14%, transparent);
  }

  .search {
    position: fixed;
    z-index: 46;
    top: 3.2rem;
    left: 50%;
    transform: translateX(-50%);
    width: min(38rem, calc(100vw - 1.5rem));
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.65rem 0.8rem;
    color: var(--ink-soft);
  }

  input {
    flex: 1;
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 0.92rem;
    outline: none;
    min-width: 0;
  }

  input::placeholder {
    color: var(--ink-faint);
  }

  .spin {
    width: 12px;
    height: 12px;
    border: 2px solid var(--line);
    border-top-color: var(--amber);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    overflow-y: auto;
    border-top: 1px solid var(--line);
  }

  .hit {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    width: 100%;
    text-align: left;
    padding: 0.42rem 0.6rem;
    border-radius: 7px;
    font-size: 0.84rem;
    cursor: pointer;
    min-width: 0;
  }

  .hit:hover {
    background: color-mix(in oklab, var(--ev) 10%, transparent);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ev);
    align-self: center;
    flex-shrink: 0;
  }

  .date {
    flex: 0 0 6.6rem;
    color: var(--ink-soft);
    font-size: 0.76rem;
  }

  .time {
    flex: 0 0 4.4rem;
    color: var(--ink-faint);
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
  }

  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.cancelled {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .go {
    color: var(--sky);
    font-size: 0.74rem;
    flex-shrink: 0;
  }

  .go:hover {
    text-decoration: underline;
  }

  .none {
    margin: 0;
    padding: 0.8rem;
    border-top: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 0.8rem;
    text-align: center;
  }

  @media (max-width: 640px) {
    .date {
      flex-basis: 4.6rem;
    }
  }
</style>
