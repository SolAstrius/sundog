<script lang="ts">
  import type { EventInstance } from "../jmap/calendar.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import {
    addDays,
    dateKey,
    fmtHour,
    fmtTime,
    isToday,
    minutesInDay,
    parseDateKey,
    startOfDay,
    startOfWeek,
  } from "../lib/dates.ts";
  import { app, isEventVisible } from "../state/app.svelte.ts";

  const HOUR_PX = 48;

  const weekStart = $derived(startOfWeek(parseDateKey(app.anchor)));
  const days = $derived(Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)));
  const colorMap = $derived(buildColorMap(app.calendars));
  const visible = $derived(app.events.filter(isEventVisible));

  interface Segment {
    ev: EventInstance;
    startMin: number;
    endMin: number;
    col: number;
    cols: number;
    color: string;
  }

  /** Assign overlap columns within one day: transitive clusters share the column count. */
  function layoutDay(segments: Segment[]): Segment[] {
    const sorted = segments.toSorted(
      (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
    );
    let cluster: Segment[] = [];
    let clusterEnd = -1;
    let colEnds: number[] = [];

    const finalize = () => {
      for (const seg of cluster) seg.cols = colEnds.length;
      cluster = [];
      colEnds = [];
    };

    for (const seg of sorted) {
      if (cluster.length && seg.startMin >= clusterEnd) finalize();
      let col = colEnds.findIndex((end) => end <= seg.startMin);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(seg.endMin);
      } else {
        colEnds[col] = seg.endMin;
      }
      seg.col = col;
      cluster.push(seg);
      clusterEnd = Math.max(clusterEnd, seg.endMin);
    }
    finalize();
    return sorted;
  }

  interface DayLane {
    day: Date;
    allDay: { ev: EventInstance; color: string }[];
    timed: Segment[];
  }

  const lanes = $derived.by((): DayLane[] => {
    return days.map((day) => {
      const dayStart = startOfDay(day).getTime();
      const dayEnd = dayStart + 86_400_000;
      const allDay: DayLane["allDay"] = [];
      const timed: Segment[] = [];
      for (const ev of visible) {
        const start = new Date(ev.utcStart).getTime();
        const end = Math.max(new Date(ev.utcEnd).getTime(), start);
        const overlaps = start < dayEnd && (end > dayStart || (end === start && start >= dayStart));
        if (!overlaps) continue;
        const color = eventColor(ev, colorMap);
        const wholeDays = ev.showWithoutTime || end - start >= 86_400_000;
        if (wholeDays) {
          allDay.push({ ev, color });
          continue;
        }
        const startMin = minutesInDay(new Date(start), day);
        const endMin = Math.max(minutesInDay(new Date(end), day), startMin + 20);
        if (endMin <= 0 || startMin >= 1440) continue;
        timed.push({ ev, startMin, endMin, col: 0, cols: 1, color });
      }
      return { day, allDay, timed: layoutDay(timed) };
    });
  });

  const hasAllDay = $derived(lanes.some((lane) => lane.allDay.length > 0));

  // Now-indicator, updated every minute.
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(timer);
  });
  const nowMin = $derived(now.getHours() * 60 + now.getMinutes());

  let scroller: HTMLDivElement | undefined = $state();
  $effect(() => {
    // Initial scroll to 07:30; re-run only when the element mounts.
    if (scroller) scroller.scrollTop = 7.5 * HOUR_PX;
  });

  function segLabel(seg: Segment): string {
    const s = new Date(seg.ev.utcStart);
    const e = new Date(seg.ev.utcEnd);
    return `${seg.ev.title || "(untitled)"} · ${fmtTime(s)} – ${fmtTime(e)}`;
  }
</script>

<div class="week">
  <div class="head">
    <div class="gutter-spacer"></div>
    {#each lanes as lane (dateKey(lane.day))}
      <div class="day-head" class:today={isToday(lane.day)}>
        <span class="wd">
          {lane.day.toLocaleDateString(undefined, { weekday: "short" })}
        </span>
        <span class="num">{lane.day.getDate()}</span>
      </div>
    {/each}
    {#if hasAllDay}
      <div class="allday-label">all-day</div>
      {#each lanes as lane (dateKey(lane.day))}
        <div class="allday-cell">
          {#each lane.allDay as item (item.ev.id)}
            <div
              class="allday-chip"
              class:cancelled={item.ev.status === "cancelled"}
              class:draft={item.ev.isDraft}
              style:--ev={item.color}
              title={item.ev.title}
            >
              {item.ev.title || "(untitled)"}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <div class="scroll" bind:this={scroller}>
    <div class="canvas" style:--hour-px="{HOUR_PX}px">
      <div class="gutter">
        {#each Array.from({ length: 23 }, (_, i) => i + 1) as hour (hour)}
          <span class="hour-label" style:top="{hour * HOUR_PX}px">{fmtHour(hour)}</span>
        {/each}
      </div>
      {#each lanes as lane (dateKey(lane.day))}
        <div class="day-col" class:today={isToday(lane.day)}>
          {#each lane.timed as seg (seg.ev.id + seg.startMin)}
            <div
              class="event"
              class:cancelled={seg.ev.status === "cancelled"}
              class:tentative={seg.ev.status === "tentative"}
              class:draft={seg.ev.isDraft}
              style:--ev={seg.color}
              style:top="{(seg.startMin / 60) * HOUR_PX}px"
              style:height="{((seg.endMin - seg.startMin) / 60) * HOUR_PX - 2}px"
              style:left="calc({(seg.col / seg.cols) * 100}% + 1px)"
              style:width="calc({(1 / seg.cols) * 100}% - 3px)"
              title={segLabel(seg)}
            >
              <span class="ev-title">{seg.ev.title || "(untitled)"}</span>
              <span class="ev-time">{fmtTime(new Date(seg.ev.utcStart))}</span>
            </div>
          {/each}
          {#if isToday(lane.day)}
            <div class="now" style:top="{(nowMin / 60) * HOUR_PX}px"></div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .week {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .head {
    display: grid;
    grid-template-columns: 56px repeat(7, 1fr);
    border-bottom: 1px solid var(--line);
    background: var(--ground);
  }

  .day-head {
    padding: 0.5rem 0 0.4rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    border-left: 1px solid var(--line-soft);
  }

  .wd {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
  }

  .num {
    font-size: 1.15rem;
    font-weight: 600;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }

  .day-head.today .wd {
    color: var(--amber);
  }

  .day-head.today .num {
    background: var(--amber);
    color: var(--amber-ink);
  }

  .allday-label {
    grid-column: 1;
    font-size: 0.62rem;
    color: var(--ink-faint);
    text-align: right;
    padding: 0.15rem 0.4rem 0.3rem 0;
    align-self: center;
  }

  .allday-cell {
    border-left: 1px solid var(--line-soft);
    border-top: 1px solid var(--line-soft);
    padding: 2px 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 1.4rem;
  }

  .allday-chip {
    background: var(--ev);
    color: var(--ground);
    border-radius: 5px;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 1px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .canvas {
    display: grid;
    grid-template-columns: 56px repeat(7, 1fr);
    height: calc(24 * var(--hour-px));
    position: relative;
  }

  .gutter {
    position: relative;
  }

  .hour-label {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
    font-size: 0.66rem;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  .day-col {
    position: relative;
    border-left: 1px solid var(--line-soft);
    background: repeating-linear-gradient(
      to bottom,
      var(--line-soft) 0 1px,
      transparent 1px var(--hour-px)
    );
  }

  .day-col.today {
    background-color: color-mix(in oklab, var(--amber) 4%, transparent);
  }

  .event {
    position: absolute;
    background: color-mix(in oklab, var(--ev) 24%, var(--ground));
    border-left: 3px solid var(--ev);
    border-radius: 4px;
    padding: 2px 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-size: 0.74rem;
    line-height: 1.25;
    box-shadow: 0 0 0 1px var(--ground);
  }

  .ev-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ev-time {
    color: var(--ink-soft);
    font-size: 0.68rem;
  }

  .event.cancelled .ev-title,
  .allday-chip.cancelled {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .event.tentative {
    opacity: 0.75;
    font-style: italic;
  }

  .event.draft,
  .allday-chip.draft {
    border: 1px dashed var(--ev);
    border-left: 3px solid var(--ev);
  }

  .now {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    border-top: 2px solid var(--now);
    z-index: 5;
  }

  .now::before {
    content: "";
    position: absolute;
    left: -4px;
    top: -5px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--now);
  }
</style>
