<script lang="ts">
  import Lock from "@lucide/svelte/icons/lock";
  import MapPin from "@lucide/svelte/icons/map-pin";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Repeat from "@lucide/svelte/icons/repeat";
  import Video from "@lucide/svelte/icons/video";
  import type { EventInstance } from "../jmap/calendar.ts";
  import { fmtSecondary } from "../lib/altcal.ts";
  import { buildColorMap, calendarColor, eventColor } from "../lib/colors.ts";
  import {
    addDays,
    dateKey,
    fmtHour,
    fmtTime,
    isoWeek,
    isToday,
    minutesInDay,
    parseDateKey,
    startOfDay,
    startOfWeek,
  } from "../lib/dates.ts";
  import { app, isDeclined, isEventVisible } from "../state/app.svelte.ts";
  import { eventWritable, mut, rescheduleInstance } from "../state/mutations.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { openEditor, openEvent, type PopoverAnchor } from "./popover.svelte.ts";

  const hourPx = $derived(settings.hourHeight);

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
    timed: Segment[];
  }

  const lanes = $derived.by((): DayLane[] => {
    return days.map((day) => {
      const dayStart = startOfDay(day).getTime();
      const dayEnd = dayStart + 86_400_000;
      const timed: Segment[] = [];
      for (const ev of visible) {
        const start = new Date(ev.utcStart).getTime();
        const end = Math.max(new Date(ev.utcEnd).getTime(), start);
        const overlaps = start < dayEnd && (end > dayStart || (end === start && start >= dayStart));
        if (!overlaps) continue;
        if (ev.showWithoutTime || end - start >= 86_400_000) continue; // → spanning bars
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
          color: eventColor(ev, colorMap),
          contStart: start < dayStart,
          contEnd: end > dayEnd,
        });
      }
      return { day, timed: layoutDay(timed) };
    });
  });

  /** All-day / multi-day events as true spanning bars across the week's columns. */
  interface AllDayBar {
    ev: EventInstance;
    startCol: number;
    endCol: number;
    lane: number;
    color: string;
    contL: boolean;
    contR: boolean;
  }

  const allDayBars = $derived.by((): AllDayBar[] => {
    const weekStartMs = startOfDay(weekStart).getTime();
    const weekEndMs = weekStartMs + 7 * 86_400_000;
    const bars: AllDayBar[] = [];
    for (const ev of visible) {
      const start = new Date(ev.utcStart).getTime();
      const end = Math.max(new Date(ev.utcEnd).getTime(), start + 1);
      if (!(ev.showWithoutTime || end - start >= 86_400_000)) continue;
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
    return bars;
  });

  const allDayLaneCount = $derived(allDayBars.reduce((max, b) => Math.max(max, b.lane + 1), 0));

  /** Cancelled-occurrence ghosts overlapping a given day (visible calendars only). */
  function ghostsFor(day: Date) {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + 86_400_000;
    return app.ghosts.filter((g) => {
      const ids = Object.keys(g.calendarIds);
      if (ids.length && !ids.some((id) => !app.hiddenCalendars[id])) return false;
      const start = new Date(g.utcStart).getTime();
      return start >= dayStart && start < dayEnd;
    }).map((g) => ({
      g,
      startMin: minutesInDay(new Date(g.utcStart), day),
      endMin: Math.max(
        minutesInDay(new Date(g.utcEnd), day),
        minutesInDay(new Date(g.utcStart), day) + 24,
      ),
    }));
  }

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
    scroller.scrollTop = 7.5 * hourPx;
    const today = scroller.querySelector<HTMLElement>(".day-col.today");
    if (today) {
      const target = today.offsetLeft - (scroller.clientWidth - today.offsetWidth) / 2;
      scroller.scrollLeft = Math.max(0, target);
    }
  });

  function segHeight(seg: Segment): number {
    return ((seg.endMin - seg.startMin) / 60) * hourPx - 2;
  }

  /** Density class: below ~2 lines only the title fits; below ~3 lines title+time inline. */
  function sizeClass(seg: Segment): string {
    const h = segHeight(seg);
    if (h < 34) return "xs";
    if (h < 58) return "sm";
    return "";
  }

  // deno-lint-ignore no-explicit-any
  function glyphs(ev: EventInstance): any[] {
    // deno-lint-ignore no-explicit-any
    const out: any[] = [];
    if (ev.recurrenceId) out.push(Repeat);
    if (ev.virtualLocations && Object.values(ev.virtualLocations).some((v) => v.uri)) {
      out.push(Video);
    } else if (ev.locations && Object.keys(ev.locations).length) out.push(MapPin);
    if (ev.links && Object.values(ev.links).some((l) => l.blobId || l.rel === "enclosure")) {
      out.push(Paperclip);
    }
    if (ev.privacy === "private" || ev.privacy === "secret") out.push(Lock);
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

  // --- direct manipulation: paint-to-create, drag-move, edge-resize ---------------------------

  const SNAP = 15;

  interface DragState {
    mode: "create" | "move" | "resize";
    ev?: EventInstance;
    color: string;
    /** Hovered column + ghost geometry (minutes within that day; move may go negative). */
    dayKey: string;
    startMin: number;
    endMin: number;
    /** Paint anchor (create) — the minute the pointer went down on. */
    anchorMin: number;
    /** Move: pointer-down instant minus event start (keeps the grab point under the cursor). */
    grabOffsetMs: number;
    moved: boolean;
  }

  let drag = $state<DragState | null>(null);
  let suppressClick = false;

  const defaultCalColor = $derived.by(() => {
    const idx = app.calendars.findIndex((c) => c.isDefault);
    const i = idx >= 0 ? idx : 0;
    const cal = app.calendars[i];
    return cal ? calendarColor(cal, i) : "var(--amber)";
  });

  const snap = (m: number) => Math.round(m / SNAP) * SNAP;

  function pointInfo(e: PointerEvent): { dayKey: string; min: number; dayMs: number } | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-day]");
    const dayKey = el?.dataset.day;
    if (!el || !dayKey) return null;
    const rect = el.getBoundingClientRect();
    const min = Math.max(0, Math.min(1440, ((e.clientY - rect.top) / hourPx) * 60));
    return { dayKey, min, dayMs: parseDateKey(dayKey).getTime() };
  }

  function onColDown(e: PointerEvent): void {
    if (e.button !== 0 || e.pointerType === "touch" || drag || mut.busy) return;
    if ((e.target as HTMLElement).closest("button, .ghost, .drag-ghost")) return;
    const info = pointInfo(e);
    if (!info) return;
    e.preventDefault();
    const anchor = Math.min(Math.floor(info.min / SNAP) * SNAP, 1440 - 60);
    drag = {
      mode: "create",
      color: defaultCalColor,
      dayKey: info.dayKey,
      startMin: anchor,
      endMin: anchor + 60,
      anchorMin: anchor,
      grabOffsetMs: 0,
      moved: false,
    };
  }

  function onChipDown(e: PointerEvent, seg: Segment): void {
    if (e.button !== 0 || e.pointerType === "touch" || drag || mut.busy) return;
    if (!eventWritable(seg.ev)) return;
    const target = e.target as HTMLElement;
    if (target.closest(".ev-join")) return;
    const info = pointInfo(e);
    if (!info) return;
    e.preventDefault();
    const pointerMs = info.dayMs + info.min * 60_000;
    drag = {
      mode: target.classList.contains("resize-handle") ? "resize" : "move",
      ev: seg.ev,
      color: seg.color,
      dayKey: info.dayKey,
      startMin: seg.startMin,
      endMin: seg.endMin,
      anchorMin: seg.startMin,
      grabOffsetMs: pointerMs - new Date(seg.ev.utcStart).getTime(),
      moved: false,
    };
  }

  function onWinMove(e: PointerEvent): void {
    if (!drag) return;
    const info = pointInfo(e);
    if (!info) return;
    const d = drag;
    if (d.mode === "create") {
      if (info.dayKey !== d.dayKey) return; // single-day paint
      const cur = snap(info.min);
      const [a, b] = cur >= d.anchorMin
        ? [d.anchorMin, Math.max(cur, d.anchorMin + SNAP)]
        : [cur, d.anchorMin + SNAP];
      if (a !== d.startMin || b !== d.endMin) {
        d.startMin = a;
        d.endMin = b;
        d.moved = true;
      }
    } else if (d.mode === "move") {
      const ev = d.ev!;
      const durMin = (new Date(ev.utcEnd).getTime() - new Date(ev.utcStart).getTime()) / 60_000;
      const rawStartMs = info.dayMs + info.min * 60_000 - d.grabOffsetMs;
      const startMin = snap((rawStartMs - info.dayMs) / 60_000);
      if (info.dayKey !== d.dayKey || startMin !== d.startMin) {
        d.dayKey = info.dayKey;
        d.startMin = startMin;
        d.endMin = startMin + durMin;
        d.moved = true;
      }
    } else {
      if (info.dayKey !== d.dayKey) return; // resize stays inside the segment's day
      const end = Math.max(snap(info.min), d.startMin + SNAP);
      if (end !== d.endMin) {
        d.endMin = end;
        d.moved = true;
      }
    }
  }

  function ghostAnchor(d: DragState): PopoverAnchor | undefined {
    const col = document.querySelector<HTMLElement>(`[data-day="${d.dayKey}"]`);
    const rect = col?.getBoundingClientRect();
    if (!rect) return undefined;
    return {
      x: rect.left,
      y: rect.top + (Math.max(0, d.startMin) / 60) * hourPx,
      w: rect.width,
      h: ((Math.min(1440, d.endMin) - Math.max(0, d.startMin)) / 60) * hourPx,
    };
  }

  function onWinUp(): void {
    const d = drag;
    if (!d) return;
    const anchor = ghostAnchor(d);
    drag = null;
    const dayMs = parseDateKey(d.dayKey).getTime();
    if (d.mode === "create") {
      openEditor(
        { startMs: dayMs + d.startMin * 60_000, endMs: dayMs + d.endMin * 60_000, allDay: false },
        anchor,
      );
      return;
    }
    if (!d.moved) return; // plain click — the chip's onclick opens the detail popover
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const ev = d.ev!;
    if (d.mode === "move") {
      const delta = dayMs + d.startMin * 60_000 - new Date(ev.utcStart).getTime();
      if (delta !== 0) void rescheduleInstance(ev, delta);
    } else {
      const durMs = dayMs + d.endMin * 60_000 - new Date(ev.utcStart).getTime();
      if (durMs > 0) void rescheduleInstance(ev, 0, durMs);
    }
  }

  function cancelDrag(): void {
    drag = null;
  }

  function onWinKey(e: KeyboardEvent): void {
    if (drag && e.key === "Escape") {
      e.stopPropagation();
      cancelDrag();
    }
  }

  function onChipClick(e: MouseEvent, seg: Segment): void {
    if (suppressClick) {
      e.stopPropagation();
      return;
    }
    openEvent(seg.ev, seg.color, e.currentTarget as Element);
  }

  function ghostLabel(d: DragState): string {
    const dayMs = parseDateKey(d.dayKey).getTime();
    const s = new Date(dayMs + d.startMin * 60_000);
    const e = new Date(dayMs + d.endMin * 60_000);
    return `${fmtTime(s)} – ${fmtTime(e)}`;
  }

  /** Video-call URL, offered on the card while ongoing or within 15 min of start. */
  function joinableUrl(ev: EventInstance): string | undefined {
    const url = Object.values(ev.virtualLocations ?? {}).find((v) => v.uri)?.uri;
    if (!url) return undefined;
    const nowMs = now.getTime();
    const start = new Date(ev.utcStart).getTime();
    const end = new Date(ev.utcEnd).getTime();
    return start - nowMs <= 15 * 60_000 && nowMs < end ? url : undefined;
  }

  function openJoin(e: Event, url: string) {
    e.stopPropagation();
    globalThis.open(url, "_blank", "noopener");
  }
</script>

<svelte:window
  onpointermove={onWinMove}
  onpointerup={onWinUp}
  onpointercancel={cancelDrag}
  onkeydown={onWinKey}
/>

<div class="week">
  <div class="scroll" bind:this={scroller}>
    <div class="sheet" style:--hour-px="{hourPx}px">
      <div class="head">
        <div class="corner">
          {#if settings.weekNumbers}<span class="wk">W{isoWeek(weekStart)}</span>{/if}
        </div>
        {#each lanes as lane (dateKey(lane.day))}
          <div class="day-head" class:today={isToday(lane.day)}>
            <span class="wd">
              {lane.day.toLocaleDateString(undefined, { weekday: "short" })}
            </span>
            <span class="num">{lane.day.getDate()}</span>
            {#if fmtSecondary(lane.day)}
              <span class="alt-date">{fmtSecondary(lane.day)}</span>
            {/if}
          </div>
        {/each}
        {#if allDayLaneCount > 0}
          <div class="allday-label">all-day</div>
          <div
            class="allday-canvas"
            style:height="{allDayLaneCount * 24 + 4}px"
          >
            {#each allDayBars as bar (bar.ev.id)}
              <button
                class="allday-bar"
                class:cancelled={bar.ev.status === "cancelled"}
                class:draft={bar.ev.isDraft}
                class:cont-l={bar.contL}
                class:cont-r={bar.contR}
                style:--ev={bar.color}
                style:left="calc({(bar.startCol / 7) * 100}% + 2px)"
                style:width="calc({((bar.endCol - bar.startCol + 1) / 7) * 100}% - 5px)"
                style:top="{bar.lane * 24 + 2}px"
                title={bar.ev.title}
                onclick={(e) => openEvent(bar.ev, bar.color, e.currentTarget)}
              >
                {bar.contL ? "‹ " : ""}{bar.ev.title || "(untitled)"}{bar.contR ? " ›" : ""}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="canvas">
        <div class="gutter">
          {#each Array.from({ length: 23 }, (_, i) => i + 1) as hour (hour)}
            <span class="hour-label" style:top="{hour * hourPx}px">{fmtHour(hour)}</span>
          {/each}
        </div>
        {#each lanes as lane (dateKey(lane.day))}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="day-col"
            class:today={isToday(lane.day)}
            class:painting={drag !== null}
            data-day={dateKey(lane.day)}
            onpointerdown={onColDown}
          >
            {#each ghostsFor(lane.day) as ghost (ghost.g.baseEventId + ghost.g.recurrenceId)}
              <div
                class="ghost"
                style:top="{(ghost.startMin / 60) * hourPx}px"
                style:height="{((ghost.endMin - ghost.startMin) / 60) * hourPx - 2}px"
                title="{ghost.g.title} — this occurrence was cancelled"
              >
                <span>{ghost.g.title}</span>
                <span class="ghost-note">cancelled</span>
              </div>
            {/each}
            {#each lane.timed as seg (seg.ev.id + seg.startMin)}
              {@const segGlyphs = glyphs(seg.ev)}
              <button
                class="event {sizeClass(seg)}"
                class:cancelled={seg.ev.status === "cancelled"}
                class:tentative={seg.ev.status === "tentative"}
                class:draft={seg.ev.isDraft}
                class:free={seg.ev.freeBusyStatus === "free"}
                class:declined={isDeclined(seg.ev)}
                class:cont-start={seg.contStart}
                class:cont-end={seg.contEnd}
                class:dragging={drag?.moved && drag.ev?.id === seg.ev.id}
                class:pending={mut.pendingIds[seg.ev.id]}
                style:--ev={seg.color}
                style:top="{(seg.startMin / 60) * hourPx}px"
                style:height="{segHeight(seg)}px"
                style:left="calc({(seg.col / seg.cols) * 100}% + 1px)"
                style:width="calc({(seg.span / seg.cols) * 100}% - 3px)"
                title={segLabel(seg)}
                onpointerdown={(e) => onChipDown(e, seg)}
                onclick={(e) => onChipClick(e, seg)}
              >
                <span class="ev-line">
                  <span class="ev-title">{seg.ev.title || "(untitled)"}</span>
                  {#if sizeClass(seg) === "sm" || sizeClass(seg) === "xs"}
                    <span class="ev-time inline">{fmtTime(new Date(seg.ev.utcStart))}</span>
                  {/if}
                  {#if segGlyphs.length}
                    <span class="ev-glyphs" aria-hidden="true">
                      {#each segGlyphs as G, i (i)}<G size={10} />{/each}
                    </span>
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
                {#if joinableUrl(seg.ev)}
                  <span
                    class="ev-join"
                    role="link"
                    tabindex="0"
                    onclick={(e) => openJoin(e, joinableUrl(seg.ev)!)}
                    onkeydown={(e) => e.key === "Enter" && openJoin(e, joinableUrl(seg.ev)!)}
                  >Join</span>
                {/if}
                {#if eventWritable(seg.ev) && !seg.contEnd && segHeight(seg) >= 24}
                  <span class="resize-handle" aria-hidden="true"></span>
                {/if}
              </button>
            {/each}
            {#if drag && drag.dayKey === dateKey(lane.day)}
              {@const gTop = Math.max(0, drag.startMin)}
              {@const gEnd = Math.min(1440, Math.max(drag.endMin, gTop + SNAP))}
              <div
                class="drag-ghost"
                style:--ev={drag.color}
                style:top="{(gTop / 60) * hourPx}px"
                style:height="{Math.max(((gEnd - gTop) / 60) * hourPx - 2, 12)}px"
              >
                <span class="dg-title">
                  {drag.mode === "create" ? "(new event)" : drag.ev?.title || "(untitled)"}
                </span>
                <span class="dg-time">{ghostLabel(drag)}</span>
              </div>
            {/if}
            {#if isToday(lane.day)}
              <div class="now" style:top="{(nowMin / 60) * hourPx}px"></div>
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

  .wk {
    display: block;
    text-align: center;
    font-size: 0.62rem;
    color: var(--ink-faint);
    padding-top: 0.6rem;
    font-variant-numeric: tabular-nums;
  }

  .alt-date {
    font-size: 0.6rem;
    color: var(--ink-faint);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 2px;
  }

  .allday-canvas {
    grid-column: 2 / span 7;
    position: relative;
    border-top: 1px solid var(--line-soft);
    background: var(--ground);
  }

  .allday-bar {
    position: absolute;
    height: 20px;
    background: var(--ev);
    color: var(--ground);
    border-radius: 5px;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    cursor: pointer;
  }

  .allday-bar:hover {
    filter: brightness(1.06);
  }

  .allday-bar.cont-l {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .allday-bar.cont-r {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .allday-bar.cancelled {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .allday-bar.draft {
    background: transparent;
    border: 1px dashed var(--ev);
    color: var(--ink);
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
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .ev-glyphs {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    opacity: 0.75;
    align-self: center;
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

  .ev-join {
    align-self: flex-start;
    margin-top: 2px;
    background: var(--amber);
    color: var(--amber-ink);
    font-weight: 700;
    font-size: 0.64rem;
    border-radius: 999px;
    padding: 0 0.5rem;
    cursor: pointer;
  }

  .ev-join:hover {
    filter: brightness(1.06);
  }

  .event.xs {
    padding: 0 5px;
    line-height: 1.1;
    font-size: 0.66rem;
    justify-content: center;
  }

  .event.cancelled .ev-title {
    text-decoration: line-through;
    opacity: 0.7;
  }

  /* Tentative: stripes say "penciled in" without reading the badge. */
  .event.tentative {
    font-style: italic;
    background: repeating-linear-gradient(
      45deg,
      color-mix(in oklab, var(--ev) 24%, var(--ground)) 0 6px,
      color-mix(in oklab, var(--ev) 10%, var(--ground)) 6px 12px
    );
  }

  /* Shows-as-free: hollow card — it doesn't block time. */
  .event.free {
    background: var(--ground);
    border: 1.5px solid var(--ev);
    border-left: 3px solid var(--ev);
  }

  /* You declined this: faded + struck. */
  .event.declined {
    opacity: 0.45;
  }

  .event.declined .ev-title {
    text-decoration: line-through;
  }

  .event.draft {
    border: 1px dashed var(--ev);
    border-left: 3px solid var(--ev);
  }

  .ghost {
    position: absolute;
    left: 2px;
    right: 3px;
    border: 1.5px dashed var(--line);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 0.68rem;
    color: var(--ink-faint);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
  }

  .ghost span:first-child {
    text-decoration: line-through;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ghost-note {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
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

  /* --- direct manipulation ------------------------------------------------------------- */

  .day-col.painting {
    user-select: none;
    cursor: default;
  }

  .event.dragging {
    opacity: 0.35;
  }

  .event.pending {
    opacity: 0.55;
    pointer-events: none;
  }

  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 7px;
    cursor: ns-resize;
  }

  .resize-handle::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 2px;
    width: 18px;
    height: 2px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: var(--ev);
    opacity: 0;
    transition: opacity 0.1s ease;
  }

  .event:hover .resize-handle::after {
    opacity: 0.7;
  }

  .drag-ghost {
    position: absolute;
    left: 1px;
    right: 2px;
    z-index: 9;
    background: color-mix(in oklab, var(--ev) 30%, var(--ground));
    border: 1.5px dashed var(--ev);
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 0.72rem;
    line-height: 1.25;
    overflow: hidden;
    pointer-events: none;
    display: flex;
    flex-direction: column;
  }

  .dg-title {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dg-time {
    color: var(--ink-soft);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
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
