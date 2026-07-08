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
  import { fmtSecondary } from "../lib/altcal.ts";
  import { isoWeek } from "../lib/dates.ts";
  import { fmtDayLong } from "../lib/format.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { app, isDeclined, isEventVisible, pathFor } from "../state/app.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { openDay, openEvent } from "./popover.svelte.ts";

  const MAX_CHIPS = 3;
  const MAX_BAR_LANES = 3;
  const BAR_H = 20;

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

  /** Cancelled-occurrence ghosts by day key (visible calendars only). */
  const ghostsByDay = $derived.by(() => {
    const map = new Map<string, typeof app.ghosts>();
    for (const g of app.ghosts) {
      const ids = Object.keys(g.calendarIds);
      if (ids.length && !ids.some((id) => !app.hiddenCalendars[id])) continue;
      const key = dateKey(new Date(g.utcStart));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(g);
    }
    return map;
  });

  function openWeek(day: Date) {
    navigate(pathFor("week", dateKey(day)));
  }

  function showAll(day: Date, chips: Chip[], el: EventTarget | null) {
    openDay(
      fmtDayLong(day),
      chips.map((c) => ({ ev: c.ev, color: c.color })),
      el as Element,
    );
  }

  // --- spanning bars per week row -------------------------------------------------------------

  interface MonthBar {
    ev: EventInstance;
    startCol: number;
    endCol: number;
    lane: number;
    color: string;
    contL: boolean;
    contR: boolean;
  }

  interface WeekRow {
    days: Date[];
    bars: MonthBar[];
    laneCount: number;
    /** Ids rendered as bars — excluded from the per-day chip stacks. */
    barIds: Set<string>;
  }

  const weeks = $derived.by((): WeekRow[] => {
    return Array.from({ length: 6 }, (_, w) => {
      const days = cells.slice(w * 7, w * 7 + 7);
      const weekStartMs = startOfDay(days[0]).getTime();
      const weekEndMs = weekStartMs + 7 * 86_400_000;
      const bars: MonthBar[] = [];
      for (const ev of app.events) {
        if (!isEventVisible(ev)) continue;
        const start = new Date(ev.utcStart).getTime();
        const end = Math.max(new Date(ev.utcEnd).getTime(), start + 1);
        const allDay = ev.showWithoutTime || end - start >= 86_400_000;
        if (!allDay) continue;
        if (end <= weekStartMs || start >= weekEndMs) continue;
        const startCol = Math.max(0, Math.floor((start - weekStartMs) / 86_400_000));
        const endCol = Math.max(
          startCol,
          Math.min(6, Math.ceil((end - weekStartMs) / 86_400_000) - 1),
        );
        bars.push({
          ev,
          startCol,
          endCol,
          lane: 0,
          color: eventColor(ev, colorMap),
          contL: start < weekStartMs,
          contR: end > weekEndMs,
        });
      }
      bars.sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol);
      const laneEnds: number[] = [];
      for (const bar of bars) {
        let lane = laneEnds.findIndex((end) => end < bar.startCol);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(bar.endCol);
        } else {
          laneEnds[lane] = bar.endCol;
        }
        bar.lane = lane;
      }
      const shown = bars.filter((b) => b.lane < MAX_BAR_LANES);
      return {
        days,
        bars: shown,
        laneCount: Math.min(laneEnds.length, MAX_BAR_LANES),
        barIds: new Set(shown.map((b) => b.ev.id)),
      };
    });
  });
</script>

<div class="month">
  <div class="wd-row">
    {#each Array.from({ length: 7 }, (_, i) => addDays(gridStart, i)) as day (day.getTime())}
      <span>{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
    {/each}
  </div>
  <div class="grid">
    {#each weeks as week, w (w)}
      <div class="week-row" style:--bars-h="{week.laneCount * BAR_H}px">
        {#if week.laneCount > 0}
          <div class="bars">
            {#each week.bars as bar (bar.ev.id + bar.startCol)}
              <button
                class="mbar"
                class:cancelled={bar.ev.status === "cancelled"}
                class:draft={bar.ev.isDraft}
                class:cont-l={bar.contL}
                class:cont-r={bar.contR}
                style:--ev={bar.color}
                style:left="calc({(bar.startCol / 7) * 100}% + 2px)"
                style:width="calc({((bar.endCol - bar.startCol + 1) / 7) * 100}% - 5px)"
                style:top="{bar.lane * BAR_H}px"
                title={bar.ev.title}
                onclick={(e) => openEvent(bar.ev, bar.color, e.currentTarget)}
              >
                {bar.contL ? "‹ " : ""}{bar.ev.title || "(untitled)"}{bar.contR ? " ›" : ""}
              </button>
            {/each}
          </div>
        {/if}
        <div class="cells">
          {#each week.days as day, dayIdx (day.getTime())}
            {@const allChips = chipsByDay.get(dateKey(day)) ?? []}
            {@const chips = allChips.filter((c) => !week.barIds.has(c.ev.id))}
            <div
              class="cell"
              class:dim={day.getMonth() !== anchorDate.getMonth()}
              class:today={isToday(day)}
            >
              <div class="cell-head">
                <button class="num" onclick={() => openWeek(day)} title="Open week view">
                  {day.getDate()}
                </button>
                {#if fmtSecondary(day)}<span class="alt">{fmtSecondary(day)}</span>{/if}
                {#if settings.weekNumbers && dayIdx === 0}
                  <span class="wknum">W{isoWeek(day)}</span>
                {/if}
              </div>
              <div class="chips">
                {#each chips.slice(0, MAX_CHIPS) as chip (chip.ev.id)}
                  <button
                    class="chip"
                    class:cancelled={chip.ev.status === "cancelled"}
                    class:draft={chip.ev.isDraft}
                    class:declined={isDeclined(chip.ev)}
                    style:--ev={chip.color}
                    title={chip.ev.title}
                    onclick={(e) => openEvent(chip.ev, chip.color, e.currentTarget)}
                  >
                    <span class="dot" aria-hidden="true"></span>
                    <span class="time">{fmtTime(new Date(chip.ev.utcStart))}</span>
                    <span class="chip-title">{chip.ev.title || "(untitled)"}</span>
                  </button>
                {/each}
                {#each ghostsByDay.get(dateKey(day)) ?? [] as g (g.baseEventId + g.recurrenceId)}
                  <span class="chip ghostchip" title="{g.title} — this occurrence was cancelled">
                    <span class="dot hollow" aria-hidden="true"></span>
                    <span class="chip-title">{g.title}</span>
                  </span>
                {/each}
                {#if chips.length > MAX_CHIPS}
                  <button class="more" onclick={(e) => showAll(day, allChips, e.currentTarget)}>
                    +{chips.length - MAX_CHIPS} more
                  </button>
                {/if}
              </div>
            </div>
          {/each}
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
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .week-row {
    flex: 1;
    position: relative;
    min-height: 0;
    border-bottom: 1px solid var(--line-soft);
    display: flex;
  }

  /* Bars overlay the strip just below the day numbers; cells reserve the space. */
  .bars {
    position: absolute;
    top: 26px;
    left: 0;
    right: 0;
    height: var(--bars-h, 0px);
    z-index: 2;
  }

  .mbar {
    position: absolute;
    height: 18px;
    background: var(--ev);
    color: var(--ground);
    border-radius: 4px;
    font-size: 0.68rem;
    font-weight: 600;
    padding: 0 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    cursor: pointer;
    z-index: 2;
  }

  .mbar:hover {
    filter: brightness(1.06);
  }

  .mbar.cont-l {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .mbar.cont-r {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .mbar.cancelled {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .mbar.draft {
    background: transparent;
    border: 1px dashed var(--ev);
    color: var(--ink);
  }

  .cells {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    min-height: 0;
  }

  .cell {
    border-right: 1px solid var(--line-soft);
    padding: 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .cell .chips {
    margin-top: var(--bars-h, 0px);
  }

  .cell-head {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .alt {
    font-size: 0.58rem;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .wknum {
    margin-left: auto;
    font-size: 0.58rem;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  .chip.declined {
    opacity: 0.45;
  }

  .chip.declined .chip-title {
    text-decoration: line-through;
  }

  .ghostchip {
    color: var(--ink-faint);
  }

  .ghostchip .chip-title {
    text-decoration: line-through;
  }

  .dot.hollow {
    background: transparent;
    border: 1.5px dashed var(--ink-faint);
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
    width: 100%;
    text-align: left;
    cursor: pointer;
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

  /* Narrow screens: drop the time column so titles keep their room. */
  @media (max-width: 640px) {
    .time {
      display: none;
    }

    .chip {
      font-size: 0.64rem;
    }

    .num {
      font-size: 0.7rem;
      width: 20px;
      height: 20px;
    }
  }
</style>
