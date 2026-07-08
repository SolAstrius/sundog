<script lang="ts">
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import {
    addDays,
    addMonths,
    dateKey,
    fmtMiniMonth,
    isToday,
    monthGridStart,
    parseDateKey,
    startOfMonth,
  } from "../lib/dates.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { app, pathFor } from "../state/app.svelte.ts";

  // Cursor follows the app anchor but can be paged independently.
  let cursor = $state(startOfMonth(new Date()));

  $effect(() => {
    cursor = startOfMonth(parseDateKey(app.anchor));
  });

  const days = $derived.by(() => {
    const start = monthGridStart(cursor);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  });

  const weekdays = ["M", "T", "W", "T", "F", "S", "S"];

  function pick(day: Date) {
    navigate(pathFor(app.view, dateKey(day)));
  }
</script>

<div class="mini">
  <div class="head">
    <span class="month">{fmtMiniMonth(cursor)}</span>
    <span class="pager">
      <button onclick={() => (cursor = addMonths(cursor, -1))} aria-label="Previous month">
        <ChevronLeft size={14} />
      </button>
      <button onclick={() => (cursor = addMonths(cursor, 1))} aria-label="Next month">
        <ChevronRight size={14} />
      </button>
    </span>
  </div>
  <div class="grid" role="grid">
    {#each weekdays as wd, i (i)}
      <span class="wd" aria-hidden="true">{wd}</span>
    {/each}
    {#each days as day (day.getTime())}
      <button
        class="day"
        class:dim={day.getMonth() !== cursor.getMonth()}
        class:today={isToday(day)}
        class:selected={dateKey(day) === app.anchor}
        onclick={() => pick(day)}
      >
        {day.getDate()}
      </button>
    {/each}
  </div>
</div>

<style>
  .mini {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.2rem;
  }

  .month {
    font-weight: 700;
    font-size: 0.85rem;
  }

  .pager button {
    padding: 0.15rem 0.3rem;
    color: var(--ink-soft);
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
  }

  .pager button:hover {
    color: var(--ink);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }

  .wd {
    text-align: center;
    font-size: 0.62rem;
    color: var(--ink-faint);
    padding-bottom: 0.15rem;
  }

  .day {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    font-size: 0.72rem;
    border-radius: 50%;
    color: var(--ink);
  }

  .day:hover {
    background: color-mix(in oklab, var(--ink) 8%, transparent);
  }

  .day.dim {
    color: var(--ink-faint);
  }

  .day.selected {
    background: color-mix(in oklab, var(--amber) 25%, transparent);
  }

  .day.today {
    background: var(--amber);
    color: var(--amber-ink);
    font-weight: 700;
  }
</style>
