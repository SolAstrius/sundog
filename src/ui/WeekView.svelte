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
  import { openEvent } from "./popover.svelte.ts";

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
    /** Columns this segment may widen into (Google-style expansion). */
    span: number;
    color: string;
    /** Continues from the previous / into the next day. */
    contStart: boolean;
    contEnd: boolean;
  }

  /**
   * Overlap layout within one day: transitive clusters share a column count; after column
   * assignment each segment expands rightward until it hits a column holding an overlapping
   * segment — wide cards whenever the density allows.
   */
  function layoutDay(segments: Segment[]): Segment[] {
    const sorted = segments.toSorted(
      (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
    );
    let cluster: Segment[] = [];
    let clusterEnd = -1;
    let colEnds: number[] = [];

    const finalize = () => {
      const cols = colEnds.length;
      for (const seg of cluster) {
        seg.cols = cols;
        let span = 1;
        expand: while (seg.col + span < cols) {
          for (const other of cluster) {
            if (
              other !== seg &&
              other.col === seg.col + span &&
              other.startMin < seg.endMin &&
              other.endMin > seg.startMin
            ) break expand;
          }
          span++;
        }
        seg.span = span;
      }
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
        timed.push({
          ev,
          startMin,
          endMin,
          col: 0,
          cols: 1,
          span: 1,
          color,
          contStart: start < dayStart,
          contEnd: end > dayEnd,
        });
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
    // Initial scroll: 07:30 vertically; horizontally center today's column when the sheet
    // overflows (narrow screens). Re-runs only when the element mounts.
    if (!scroller) return;
    scroller.scrollTop = 7.5 * HOUR_PX;
    const today = scroller.querySelector<HTMLElement>(".day-col.today");
    if (today) {
      const target = today.offsetLeft - (scroller.clientWidth - today.offsetWidth) / 2;
      scroller.scrollLeft = Math.max(0, target);
    }
  });

  function segHeight(seg: Segment): number {
    return ((seg.endMin - seg.startMin) / 60) * HOUR_PX - 2;
  }

  /** Density class: below ~2 lines only the title fits; below ~3 lines title+time inline. */
  function sizeClass(seg: Segment): string {
    const h = segHeight(seg);
    if (h < 34) return "xs";
    if (h < 58) return "sm";
    return "";
  }

  function glyphs(ev: EventInstance): string {
    let out = "";
    if (ev.recurrenceId) out += "⟳";
    if (ev.virtualLocations && Object.values(ev.virtualLocations).some((v) => v.uri)) out += "🎥";
    else if (ev.locations && Object.keys(ev.locations).length) out += "📍";
    if (ev.privacy === "private" || ev.privacy === "secret") out += "🔒";
    return out;
  }

  function firstLocationName(ev: EventInstance): string {
    const loc = Object.values(ev.locations ?? {})[0];
    return loc?.name ?? "";
  }

  function segLabel(seg: Segment): string {
    const s = new Date(seg.ev.utcStart);
    const e = new Date(seg.ev.utcEnd);
    return `${seg.ev.title || "(untitled)"} · ${fmtTime(s)} – ${fmtTime(e)}`;
  }
</script>

<div class="week">
  <div class="scroll" bind:this={scroller}>
    <div class="sheet" style:--hour-px="{HOUR_PX}px">
      <div class="head">
        <div class="corner"></div>
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
                <button
                  class="allday-chip"
                  class:cancelled={item.ev.status === "cancelled"}
                  class:draft={item.ev.isDraft}
                  style:--ev={item.color}
                  title={item.ev.title}
                  onclick={(e) => openEvent(item.ev, item.color, e.currentTarget)}
                >
                  {item.ev.title || "(untitled)"}
                </button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>

      <div class="canvas">
        <div class="gutter">
          {#each Array.from({ length: 23 }, (_, i) => i + 1) as hour (hour)}
            <span class="hour-label" style:top="{hour * HOUR_PX}px">{fmtHour(hour)}</span>
          {/each}
        </div>
        {#each lanes as lane (dateKey(lane.day))}
          <div class="day-col" class:today={isToday(lane.day)}>
            {#each lane.timed as seg (seg.ev.id + seg.startMin)}
              <button
                class="event {sizeClass(seg)}"
                class:cancelled={seg.ev.status === "cancelled"}
                class:tentative={seg.ev.status === "tentative"}
                class:draft={seg.ev.isDraft}
                class:cont-start={seg.contStart}
                class:cont-end={seg.contEnd}
                style:--ev={seg.color}
                style:top="{(seg.startMin / 60) * HOUR_PX}px"
                style:height="{segHeight(seg)}px"
                style:left="calc({(seg.col / seg.cols) * 100}% + 1px)"
                style:width="calc({(seg.span / seg.cols) * 100}% - 3px)"
                title={segLabel(seg)}
                onclick={(e) => openEvent(seg.ev, seg.color, e.currentTarget)}
              >
                <span class="ev-line">
                  <span class="ev-title">{seg.ev.title || "(untitled)"}</span>
                  {#if sizeClass(seg) === "sm" || sizeClass(seg) === "xs"}
                    <span class="ev-time inline">{fmtTime(new Date(seg.ev.utcStart))}</span>
                  {/if}
                  {#if glyphs(seg.ev)}
                    <span class="ev-glyphs" aria-hidden="true">{glyphs(seg.ev)}</span>
                  {/if}
                </span>
                {#if !sizeClass(seg)}
                  <span class="ev-time">
                    {fmtTime(new Date(seg.ev.utcStart))} – {fmtTime(new Date(seg.ev.utcEnd))}
                  </span>
                  {#if segHeight(seg) >= 92 && firstLocationName(seg.ev)}
                    <span class="ev-loc">{firstLocationName(seg.ev)}</span>
                  {/if}
                {/if}
              </button>
            {/each}
            {#if isToday(lane.day)}
              <div class="now" style:top="{(nowMin / 60) * HOUR_PX}px"></div>
            {/if}
          </div>
        {/each}
      </div>
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

  .scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  /* Shared column template; min column width keeps cards readable on narrow screens
     (the sheet then scrolls horizontally instead of crushing the columns). */
  .sheet {
    --cols: 52px repeat(7, minmax(7.5rem, 1fr));
    min-width: fit-content;
  }

  .head {
    display: grid;
    grid-template-columns: var(--cols);
    border-bottom: 1px solid var(--line);
    background: var(--ground);
    position: sticky;
    top: 0;
    z-index: 12;
  }

  .corner {
    position: sticky;
    left: 0;
    background: var(--ground);
    z-index: 13;
  }

  .day-head {
    padding: 0.5rem 0 0.4rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    border-left: 1px solid var(--line-soft);
    background: var(--ground);
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
    position: sticky;
    left: 0;
    background: var(--ground);
    z-index: 13;
  }

  .allday-cell {
    border-left: 1px solid var(--line-soft);
    border-top: 1px solid var(--line-soft);
    padding: 2px 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 1.4rem;
    background: var(--ground);
    min-width: 0;
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
    text-align: left;
    width: 100%;
    cursor: pointer;
  }

  .canvas {
    display: grid;
    grid-template-columns: var(--cols);
    height: calc(24 * var(--hour-px));
    position: relative;
  }

  .gutter {
    position: sticky;
    left: 0;
    background: var(--ground);
    z-index: 6;
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
    min-width: 0;
  }

  .day-col.today {
    background-color: color-mix(in oklab, var(--amber) 4%, transparent);
  }

  .event {
    position: absolute;
    background: color-mix(in oklab, var(--ev) 24%, var(--ground));
    border-left: 3px solid var(--ev);
    border-radius: 4px;
    padding: 2px 5px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    text-align: left;
    font-size: 0.74rem;
    line-height: 1.25;
    box-shadow: 0 0 0 1px var(--ground);
    cursor: pointer;
    transition: filter 0.1s ease;
  }

  .event:hover {
    filter: brightness(1.03);
    z-index: 8;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.18);
  }

  .ev-line {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
  }

  .ev-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }

  .event:not(.xs):not(.sm) .ev-title {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .ev-glyphs {
    flex-shrink: 0;
    font-size: 0.62rem;
    opacity: 0.85;
  }

  .ev-time {
    color: var(--ink-soft);
    font-size: 0.68rem;
  }

  .ev-time.inline {
    flex-shrink: 0;
  }

  .ev-loc {
    color: var(--ink-soft);
    font-size: 0.66rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 1px;
  }

  .event.xs {
    padding: 0 5px;
    line-height: 1.1;
    font-size: 0.66rem;
    justify-content: center;
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

  /* Midnight continuation: flatten + notch the crossing edge. */
  .event.cont-start {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: 2px dotted var(--ev);
  }

  .event.cont-end {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom: 2px dotted var(--ev);
  }

  .now {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    border-top: 2px solid var(--now);
    z-index: 5;
    pointer-events: none;
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
