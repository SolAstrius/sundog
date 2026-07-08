<script lang="ts">
  import Video from "@lucide/svelte/icons/video";
  import type { EventInstance } from "../jmap/calendar.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import { fmtTime } from "../lib/dates.ts";
  import { app, isEventVisible } from "../state/app.svelte.ts";
  import { openEvent } from "./popover.svelte.ts";

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const colorMap = $derived(buildColorMap(app.calendars));

  function timed(ev: EventInstance): boolean {
    const span = new Date(ev.utcEnd).getTime() - new Date(ev.utcStart).getTime();
    return !ev.showWithoutTime && span < 86_400_000 && ev.status !== "cancelled";
  }

  const ongoing = $derived.by(() =>
    app.events
      .filter((ev) =>
        isEventVisible(ev) && timed(ev) &&
        new Date(ev.utcStart).getTime() <= now && now < new Date(ev.utcEnd).getTime()
      )
      .toSorted((a, b) => a.utcEnd.localeCompare(b.utcEnd))[0]
  );

  const next = $derived.by(() =>
    app.events
      .filter((ev) => {
        if (!isEventVisible(ev) || !timed(ev)) return false;
        const start = new Date(ev.utcStart).getTime();
        return start > now && start - now < 8 * 3_600_000;
      })
      .toSorted((a, b) => a.utcStart.localeCompare(b.utcStart))[0]
  );

  export function joinUrl(ev: EventInstance): string | undefined {
    return Object.values(ev.virtualLocations ?? {}).find((v) => v.uri)?.uri;
  }

  function untilText(ev: EventInstance): string {
    const mins = Math.max(1, Math.round((new Date(ev.utcEnd).getTime() - now) / 60_000));
    return mins >= 60 ? `until ${fmtTime(new Date(ev.utcEnd))}` : `${mins} min left`;
  }

  function inText(ev: EventInstance): string {
    const mins = Math.round((new Date(ev.utcStart).getTime() - now) / 60_000);
    if (mins < 60) return `in ${Math.max(mins, 1)} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `in ${h} h ${m} m` : `in ${h} h`;
  }

  /** Join is offered while ongoing or within 15 minutes of start. */
  function joinable(ev: EventInstance): string | undefined {
    const url = joinUrl(ev);
    if (!url) return undefined;
    const start = new Date(ev.utcStart).getTime();
    const end = new Date(ev.utcEnd).getTime();
    return start - now <= 15 * 60_000 && now < end ? url : undefined;
  }
</script>

{#if ongoing || next}
  <div class="nowbar">
    {#if ongoing}
      {@const color = eventColor(ongoing, colorMap)}
      <button
        class="item"
        style:--ev={color}
        onclick={(e) => openEvent(ongoing, color, e.currentTarget)}
      >
        <span class="pulse" aria-hidden="true"></span>
        <span class="label">Now</span>
        <span class="name">{ongoing.title || "(untitled)"}</span>
        <span class="when">{untilText(ongoing)}</span>
      </button>
      {#if joinable(ongoing)}
        <a class="join" href={joinable(ongoing)} target="_blank" rel="noopener noreferrer">
          <Video size={13} /> Join
        </a>
      {/if}
    {/if}
    {#if next}
      {@const color = eventColor(next, colorMap)}
      <button
        class="item"
        style:--ev={color}
        onclick={(e) => openEvent(next, color, e.currentTarget)}
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="label">Next</span>
        <span class="name">{next.title || "(untitled)"}</span>
        <span class="when">{inText(next)} · {fmtTime(new Date(next.utcStart))}</span>
      </button>
      {#if joinable(next)}
        <a class="join" href={joinable(next)} target="_blank" rel="noopener noreferrer">
          <Video size={13} /> Join
        </a>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .nowbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.9rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    overflow-x: auto;
    white-space: nowrap;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.78rem;
    cursor: pointer;
    min-width: 0;
  }

  .item:hover {
    background: color-mix(in oklab, var(--ev) 12%, transparent);
  }

  .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--now);
    animation: pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ev);
    flex-shrink: 0;
  }

  .label {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
    flex-shrink: 0;
  }

  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 16rem;
  }

  .when {
    color: var(--ink-soft);
    font-size: 0.72rem;
    flex-shrink: 0;
  }

  .join {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: var(--amber);
    color: var(--amber-ink);
    font-weight: 700;
    font-size: 0.74rem;
    border-radius: 999px;
    padding: 0.18rem 0.65rem;
    text-decoration: none;
    flex-shrink: 0;
  }

  .join:hover {
    filter: brightness(1.05);
  }
</style>
