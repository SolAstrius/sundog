<script lang="ts">
  import { addDays, dateKey, isToday, monthGridStart, parseDateKey } from "../lib/dates.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { app, isEventVisible, pathFor } from "../state/app.svelte.ts";

  const year = $derived(parseDateKey(app.anchor).getFullYear());
  const months = $derived(Array.from({ length: 12 }, (_, m) => new Date(year, m, 1)));

  /** Visible-event count per day key — the heatmap source. */
  const density = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const ev of app.events) {
      if (!isEventVisible(ev)) continue;
      const key = dateKey(new Date(ev.utcStart));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  /** 0–4 heat bucket. */
  function heat(day: Date): number {
    const n = density.get(dateKey(day)) ?? 0;
    if (n === 0) return 0;
    if (n <= 1) return 1;
    if (n <= 2) return 2;
    if (n <= 4) return 3;
    return 4;
  }

  const monthNameFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
  const weekdays = ["M", "T", "W", "T", "F", "S", "S"];

  function cells(month: Date): Date[] {
    const start = monthGridStart(month);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
</script>

<div class="year">
  <div class="grid">
    {#each months as month (month.getTime())}
      <section class="mon">
        <button class="mon-name" onclick={() => navigate(pathFor("month", dateKey(month)))}>
          {monthNameFmt.format(month)}
        </button>
        <div class="days">
          {#each weekdays as wd, i (i)}<span class="wd" aria-hidden="true">{wd}</span>{/each}
          {#each cells(month) as day (day.getTime())}
            {#if day.getMonth() === month.getMonth()}
              <button
                class="day heat-{heat(day)}"
                class:today={isToday(day)}
                title="{density.get(dateKey(day)) ?? 0} events"
                onclick={() => navigate(pathFor("week", dateKey(day)))}
              >
                {day.getDate()}
              </button>
            {:else}
              <span class="day pad"></span>
            {/if}
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>

<style>
  .year {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 1rem 1.2rem 2rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
    gap: 1.3rem 1.6rem;
    max-width: 72rem;
    margin: 0 auto;
  }

  .mon-name {
    font-weight: 700;
    font-size: 0.9rem;
    padding: 0.1rem 0.3rem;
    border-radius: 5px;
    margin-bottom: 0.25rem;
  }

  .mon-name:hover {
    background: color-mix(in oklab, var(--ink) 7%, transparent);
  }

  .days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }

  .wd {
    text-align: center;
    font-size: 0.58rem;
    color: var(--ink-faint);
    padding-bottom: 0.1rem;
  }

  .day {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    font-size: 0.68rem;
    border-radius: 50%;
    color: var(--ink);
  }

  .day.pad {
    visibility: hidden;
  }

  .day:not(.pad):hover {
    outline: 1px solid var(--amber);
  }

  .heat-1 {
    background: color-mix(in oklab, var(--amber) 14%, transparent);
  }

  .heat-2 {
    background: color-mix(in oklab, var(--amber) 30%, transparent);
  }

  .heat-3 {
    background: color-mix(in oklab, var(--amber) 48%, transparent);
    color: var(--amber-ink);
  }

  .heat-4 {
    background: color-mix(in oklab, var(--amber) 70%, transparent);
    color: var(--amber-ink);
    font-weight: 600;
  }

  .day.today {
    outline: 2px solid var(--amber);
    font-weight: 700;
  }
</style>
