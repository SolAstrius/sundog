<script lang="ts">
  import type { EventInstance } from "../jmap/calendar.ts";
  import { calendarColor } from "../lib/colors.ts";
  import { fmtHour, fmtTime, isToday, minutesInDay, parseDateKey } from "../lib/dates.ts";
  import { app, isEventVisible } from "../state/app.svelte.ts";
  import { openEvent } from "./popover.svelte.ts";

  const day = $derived(parseDateKey(app.anchor));

  interface Bar {
    ev: EventInstance;
    startMin: number;
    endMin: number;
    /** Sub-row within the lane (overlap stacking). */
    row: number;
    allDay: boolean;
  }

  interface Lane {
    id: string;
    name: string;
    color: string;
    bars: Bar[];
    rows: number;
  }

  /** Greedy sub-row packing: first row whose last bar ends before this one starts. */
  function pack(bars: Bar[]): number {
    const sorted = bars.toSorted((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    const rowEnds: number[] = [];
    for (const bar of sorted) {
      let row = rowEnds.findIndex((end) => end <= bar.startMin);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(bar.endMin);
      } else {
        rowEnds[row] = bar.endMin;
      }
      bar.row = row;
    }
    return Math.max(rowEnds.length, 1);
  }

  const lanes = $derived.by((): Lane[] => {
    const dayStart = day.getTime();
    const dayEnd = dayStart + 86_400_000;
    return app.calendars
      .filter((cal) => !app.hiddenCalendars[cal.id])
      .map((cal, i) => {
        const bars: Bar[] = [];
        for (const ev of app.events) {
          if (!ev.calendarIds[cal.id] || !isEventVisible(ev)) continue;
          const start = new Date(ev.utcStart).getTime();
          const end = Math.max(new Date(ev.utcEnd).getTime(), start);
          const overlaps = start < dayEnd &&
            (end > dayStart || (end === start && start >= dayStart));
          if (!overlaps) continue;
          const allDay = ev.showWithoutTime || end - start >= 86_400_000;
          const startMin = allDay ? 0 : minutesInDay(new Date(start), day);
          const endMin = allDay
            ? 1440
            : Math.max(minutesInDay(new Date(end), day), startMin + 15);
          bars.push({ ev, startMin, endMin, row: 0, allDay });
        }
        return {
          id: cal.id,
          name: cal.name,
          color: calendarColor(cal, i),
          bars,
          rows: pack(bars),
        };
      });
  });

  // Now line, updated every minute.
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(timer);
  });
  const nowMin = $derived(now.getHours() * 60 + now.getMinutes());

  const ROW_PX = 30;

  function barLabel(bar: Bar): string {
    return `${bar.ev.title || "(untitled)"} · ${fmtTime(new Date(bar.ev.utcStart))} – ${
      fmtTime(new Date(bar.ev.utcEnd))
    }`;
  }
</script>

<div class="planner">
  <div class="sheet">
    <div class="ruler">
      <div class="corner"></div>
      <div class="hours">
        {#each Array.from({ length: 24 }, (_, h) => h) as hour (hour)}
          <span class="hour" style:left="{(hour / 24) * 100}%">{fmtHour(hour)}</span>
        {/each}
      </div>
    </div>
    {#each lanes as lane (lane.id)}
      <div class="lane" style:--lane={lane.color}>
        <div class="label">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{lane.name}</span>
        </div>
        <div class="track" style:height="{Math.max(lane.rows, 1) * ROW_PX + 8}px">
          {#each Array.from({ length: 23 }, (_, i) => i + 1) as hour (hour)}
            <div class="tick" style:left="{(hour / 24) * 100}%"></div>
          {/each}
          {#each lane.bars as bar (bar.ev.id)}
            <button
              class="bar"
              class:allday={bar.allDay}
              class:cancelled={bar.ev.status === "cancelled"}
              style:--ev={bar.ev.color ?? lane.color}
              style:left="{(bar.startMin / 1440) * 100}%"
              style:width="calc({((bar.endMin - bar.startMin) / 1440) * 100}% - 2px)"
              style:top="{bar.row * ROW_PX + 4}px"
              title={barLabel(bar)}
              onclick={(e) => openEvent(bar.ev, bar.ev.color ?? lane.color, e.currentTarget)}
            >
              {bar.ev.title || "(untitled)"}
            </button>
          {/each}
          {#if isToday(day)}
            <div class="now" style:left="{(nowMin / 1440) * 100}%"></div>
          {/if}
        </div>
      </div>
    {/each}
    {#if lanes.every((lane) => lane.bars.length === 0) && !app.loading}
      <p class="empty">Nothing scheduled this day.</p>
    {/if}
  </div>
</div>

<style>
  .planner {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  .sheet {
    min-width: 56rem;
    padding-bottom: 2rem;
  }

  .ruler {
    display: flex;
    position: sticky;
    top: 0;
    background: var(--ground);
    z-index: 5;
    border-bottom: 1px solid var(--line);
  }

  .corner {
    flex: 0 0 11rem;
    position: sticky;
    left: 0;
    background: var(--ground);
  }

  .hours {
    flex: 1;
    position: relative;
    height: 1.6rem;
  }

  .hour {
    position: absolute;
    top: 0.25rem;
    transform: translateX(-50%);
    font-size: 0.62rem;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  .lane {
    display: flex;
    border-bottom: 1px solid var(--line-soft);
  }

  .label {
    flex: 0 0 11rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    position: sticky;
    left: 0;
    background: var(--ground);
    z-index: 4;
    border-right: 1px solid var(--line-soft);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--lane);
    flex-shrink: 0;
  }

  .name {
    font-weight: 600;
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    flex: 1;
    position: relative;
    min-width: 0;
  }

  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--line-soft);
  }

  .bar {
    position: absolute;
    height: 24px;
    background: color-mix(in oklab, var(--ev) 26%, var(--ground));
    border-left: 3px solid var(--ev);
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    cursor: pointer;
    box-shadow: 0 0 0 1px var(--ground);
  }

  .bar:hover {
    z-index: 3;
    filter: brightness(1.04);
  }

  .bar.allday {
    background: var(--ev);
    color: var(--ground);
  }

  .bar.cancelled {
    text-decoration: line-through;
    opacity: 0.65;
  }

  .now {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--now);
    z-index: 2;
    pointer-events: none;
  }

  .empty {
    text-align: center;
    color: var(--ink-faint);
    padding: 2rem 0;
  }
</style>
