<script lang="ts">
  import type { EventInstance } from "../jmap/calendar.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import {
    addDays,
    dateKey,
    fmtTime,
    isToday,
    monthGridStart,
    parseDateKey,
    startOfDay,
  } from "../lib/dates.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { app, isEventVisible, pathFor } from "../state/app.svelte.ts";

  const MAX_CHIPS = 4;

  const anchorDate = $derived(parseDateKey(app.anchor));
  const gridStart = $derived(monthGridStart(anchorDate));
  const cells = $derived(Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)));
  const colorMap = $derived(buildColorMap(app.calendars));

  interface Chip {
    ev: EventInstance;
    color: string;
    allDay: boolean;
  }

  const chipsByDay = $derived.by(() => {
    const map = new Map<string, Chip[]>();
    const gridEnd = addDays(gridStart, 42).getTime();
    for (const ev of app.events) {
      if (!isEventVisible(ev)) continue;
      const start = new Date(ev.utcStart).getTime();
      const end = Math.max(new Date(ev.utcEnd).getTime(), start);
      const allDay = ev.showWithoutTime || end - start >= 86_400_000;
      const color = eventColor(ev, colorMap);
      // Walk each grid day the event covers (end exclusive; zero-duration counts its start day).
      let day = startOfDay(new Date(start));
      let guard = 0;
      while (day.getTime() < gridEnd && (day.getTime() < end || end === start) && guard < 60) {
        if (day.getTime() >= gridStart.getTime() && day.getTime() + 86_400_000 > start) {
          const key = dateKey(day);
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({ ev, color, allDay });
        }
        if (end === start) break;
        day = addDays(day, 1);
        guard++;
      }
    }
    for (const chips of map.values()) {
      chips.sort((a, b) =>
        Number(b.allDay) - Number(a.allDay) || a.ev.utcStart.localeCompare(b.ev.utcStart)
      );
    }
    return map;
  });

  function openWeek(day: Date) {
    navigate(pathFor("week", dateKey(day)));
  }
</script>

<div class="month">
  <div class="wd-row">
    {#each Array.from({ length: 7 }, (_, i) => addDays(gridStart, i)) as day (day.getTime())}
      <span>{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
    {/each}
  </div>
  <div class="grid">
    {#each cells as day (day.getTime())}
      {@const chips = chipsByDay.get(dateKey(day)) ?? []}
      <div
        class="cell"
        class:dim={day.getMonth() !== anchorDate.getMonth()}
        class:today={isToday(day)}
      >
        <button class="num" onclick={() => openWeek(day)} title="Open week view">
          {day.getDate()}
        </button>
        <div class="chips">
          {#each chips.slice(0, MAX_CHIPS) as chip (chip.ev.id)}
            <div
              class="chip"
              class:allday={chip.allDay}
              class:cancelled={chip.ev.status === "cancelled"}
              class:draft={chip.ev.isDraft}
              style:--ev={chip.color}
              title={chip.ev.title}
            >
              {#if !chip.allDay}
                <span class="dot" aria-hidden="true"></span>
                <span class="time">{fmtTime(new Date(chip.ev.utcStart))}</span>
              {/if}
              <span class="chip-title">{chip.ev.title || "(untitled)"}</span>
            </div>
          {/each}
          {#if chips.length > MAX_CHIPS}
            <button class="more" onclick={() => openWeek(day)}>
              +{chips.length - MAX_CHIPS} more
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .month {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .wd-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--line);
  }

  .wd-row span {
    text-align: center;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
    padding: 0.4rem 0;
  }

  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-template-rows: repeat(6, minmax(0, 1fr));
    min-height: 0;
  }

  .cell {
    border-right: 1px solid var(--line-soft);
    border-bottom: 1px solid var(--line-soft);
    padding: 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .cell.dim {
    background: color-mix(in oklab, var(--panel) 55%, var(--ground));
  }

  .cell.dim .num {
    color: var(--ink-faint);
  }

  .num {
    align-self: flex-start;
    font-size: 0.78rem;
    font-weight: 600;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }

  .num:hover {
    background: color-mix(in oklab, var(--ink) 8%, transparent);
  }

  .cell.today .num {
    background: var(--amber);
    color: var(--amber-ink);
  }

  .chips {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
    line-height: 1.35;
    padding: 0 4px;
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
  }

  .chip:hover {
    background: color-mix(in oklab, var(--ink) 6%, transparent);
  }

  .chip.allday {
    background: var(--ev);
    color: var(--ground);
    font-weight: 600;
    padding: 1px 6px;
  }

  .chip.cancelled .chip-title {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .chip.draft {
    border: 1px dashed var(--ev);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ev);
    flex-shrink: 0;
  }

  .time {
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .more {
    align-self: flex-start;
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--ink-soft);
    padding: 0 4px;
    border-radius: 4px;
  }

  .more:hover {
    background: color-mix(in oklab, var(--ink) 8%, transparent);
    color: var(--ink);
  }
</style>
