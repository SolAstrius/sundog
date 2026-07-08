<script lang="ts">
  import MapPin from "@lucide/svelte/icons/map-pin";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Repeat from "@lucide/svelte/icons/repeat";
  import Video from "@lucide/svelte/icons/video";
  import type { EventInstance } from "../jmap/calendar.ts";
  import { fmtSecondary } from "../lib/altcal.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import { addDays, dateKey, fmtTime, isToday, parseDateKey, startOfDay } from "../lib/dates.ts";
  import { app, extendAgenda, isEventVisible } from "../state/app.svelte.ts";
  import { openEvent } from "./popover.svelte.ts";

  const colorMap = $derived(buildColorMap(app.calendars));

  interface Row {
    ev: EventInstance;
    color: string;
    allDay: boolean;
  }

  interface DayGroup {
    day: Date;
    rows: Row[];
  }

  /** Non-empty days in the window; multi-day events appear on every day they cover. */
  const groups = $derived.by((): DayGroup[] => {
    const start = startOfDay(parseDateKey(app.anchor));
    const windowEnd = addDays(start, app.agendaDays).getTime();
    const byDay = new Map<string, Row[]>();
    for (const ev of app.events) {
      if (!isEventVisible(ev)) continue;
      const evStart = new Date(ev.utcStart).getTime();
      const evEnd = Math.max(new Date(ev.utcEnd).getTime(), evStart);
      const allDay = ev.showWithoutTime || evEnd - evStart >= 86_400_000;
      const color = eventColor(ev, colorMap);
      let day = startOfDay(new Date(Math.max(evStart, start.getTime())));
      let guard = 0;
      while (
        day.getTime() < windowEnd &&
        (day.getTime() < evEnd || evEnd === evStart) &&
        guard < 400
      ) {
        if (day.getTime() + 86_400_000 > evStart) {
          const key = dateKey(day);
          if (!byDay.has(key)) byDay.set(key, []);
          byDay.get(key)!.push({ ev, color, allDay });
        }
        if (evEnd === evStart) break;
        day = addDays(day, 1);
        guard++;
      }
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => ({
        day: parseDateKey(key),
        rows: rows.sort((a, b) =>
          Number(b.allDay) - Number(a.allDay) || a.ev.utcStart.localeCompare(b.ev.utcStart)
        ),
      }));
  });

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric" });
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });

  function locationName(ev: EventInstance): string {
    return Object.values(ev.locations ?? {})[0]?.name ?? "";
  }

  function hasVideo(ev: EventInstance): boolean {
    return !!ev.virtualLocations && Object.values(ev.virtualLocations).some((v) => v.uri);
  }

  function hasFiles(ev: EventInstance): boolean {
    return !!ev.links &&
      Object.values(ev.links).some((l) => l.blobId || l.rel === "enclosure");
  }

  /** Load-more sentinel: extend the window when it scrolls into view. */
  function sentinel(node: HTMLElement) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) extendAgenda();
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div class="agenda">
  {#if groups.length === 0 && !app.loading}
    <p class="empty">Nothing scheduled in the next {app.agendaDays} days.</p>
  {/if}
  {#each groups as group (dateKey(group.day))}
    <section class="day" class:today={isToday(group.day)}>
      <div class="datecol">
        <span class="wd">{dayFmt.format(group.day)}</span>
        <span class="num">{dateFmt.format(group.day)}</span>
        <span class="mo">{monthFmt.format(group.day)}</span>
        {#if fmtSecondary(group.day)}
          <span class="mo alt">{fmtSecondary(group.day)}</span>
        {/if}
      </div>
      <div class="rows">
        {#each group.rows as row (row.ev.id)}
          <button
            class="row"
            class:cancelled={row.ev.status === "cancelled"}
            class:tentative={row.ev.status === "tentative"}
            style:--ev={row.color}
            onclick={(e) => openEvent(row.ev, row.color, e.currentTarget)}
          >
            <span class="time">
              {#if row.allDay}
                all day
              {:else}
                {fmtTime(new Date(row.ev.utcStart))} – {fmtTime(new Date(row.ev.utcEnd))}
              {/if}
            </span>
            <span class="dot" aria-hidden="true"></span>
            <span class="title">{row.ev.title || "(untitled)"}</span>
            <span class="meta">
              {#if row.ev.recurrenceId}<Repeat size={11} />{/if}
              {#if hasVideo(row.ev)}<Video size={11} />{/if}
              {#if hasFiles(row.ev)}<Paperclip size={11} />{/if}
              {#if locationName(row.ev)}
                <span class="loc"><MapPin size={11} /> {locationName(row.ev)}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/each}
  {#if app.agendaDays < 360}
    <div class="more" use:sentinel>
      <button class="btn" onclick={extendAgenda} disabled={app.loading}>
        {app.loading ? "Loading…" : "Load more"}
      </button>
    </div>
  {:else}
    <p class="empty">Showing a full year — the server expands at most that much at once.</p>
  {/if}
</div>

<style>
  .agenda {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 0.6rem 1rem 2rem;
    max-width: 52rem;
    width: 100%;
    margin: 0 auto;
  }

  .day {
    display: flex;
    gap: 0.9rem;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--line-soft);
  }

  .datecol {
    flex: 0 0 3.4rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    padding-top: 0.3rem;
    position: sticky;
    top: 0;
  }

  .wd {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
  }

  .num {
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1.2;
    width: 2.2rem;
    height: 2.2rem;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }

  .day.today .num {
    background: var(--amber);
    color: var(--amber-ink);
  }

  .mo {
    font-size: 0.62rem;
    color: var(--ink-faint);
  }

  .rows {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.4rem 0.5rem;
    border-radius: 7px;
    text-align: left;
    min-width: 0;
    cursor: pointer;
  }

  .row:hover {
    background: color-mix(in oklab, var(--ev) 10%, transparent);
  }

  .time {
    flex: 0 0 7.4rem;
    color: var(--ink-soft);
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ev);
    flex-shrink: 0;
    align-self: center;
  }

  .title {
    font-weight: 600;
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.cancelled .title {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .row.tentative .title {
    font-style: italic;
    opacity: 0.85;
  }

  .meta {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ink-faint);
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
  }

  .loc {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.74rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .more {
    display: flex;
    justify-content: center;
    padding: 1.2rem 0 0.6rem;
  }

  .empty {
    text-align: center;
    color: var(--ink-faint);
    padding: 1.4rem 0;
  }

  @media (max-width: 640px) {
    .agenda {
      padding: 0.4rem 0.5rem 2rem;
    }

    .time {
      flex-basis: 4.6rem;
      font-size: 0.68rem;
    }

    .loc {
      display: none;
    }
  }
</style>
