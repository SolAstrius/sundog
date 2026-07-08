<script lang="ts">
  import type { EventInstance, EventLocation, EventParticipant } from "../jmap/calendar.ts";
  import { stalwartProvider } from "../core/provider/stalwart.ts";
  import type { TypedEvent } from "../core/schemas/jscalendar.ts";
  import { BROWSER_TZ } from "../lib/dates.ts";
  import {
    fmtRange,
    fmtTimeInZone,
    geoToMapUrl,
    htmlToText,
    humanizeOffset,
    linkify,
  } from "../lib/format.ts";
  import { app } from "../state/app.svelte.ts";
  import { closePopover, openEvent, pop } from "./popover.svelte.ts";

  const normalize = stalwartProvider().normalize;

  const ev = $derived(pop.ev);
  const isAllDay = $derived.by(() => {
    if (!ev) return false;
    const span = new Date(ev.utcEnd).getTime() - new Date(ev.utcStart).getTime();
    return ev.showWithoutTime || span >= 86_400_000;
  });
  const range = $derived(ev ? fmtRange(ev.utcStart, ev.utcEnd, isAllDay) : undefined);

  /** Second time line in the event's own zone when it differs from the browser's. */
  const zonedTime = $derived.by(() => {
    if (!ev?.timeZone || ev.timeZone === BROWSER_TZ || isAllDay) return undefined;
    const s = new Date(ev.utcStart);
    const e = new Date(ev.utcEnd);
    return `${fmtTimeInZone(s, ev.timeZone)} – ${fmtTimeInZone(e, ev.timeZone)} in ${ev.timeZone}`;
  });

  const descriptionText = $derived.by(() => {
    if (!ev?.description) return "";
    return ev.descriptionContentType === "text/html" ? htmlToText(ev.description) : ev.description;
  });

  interface LocEntry {
    label: string;
    loc: EventLocation;
    /** Wall time at that location for its relativeTo instant (travel events). */
    localTime?: string;
    mapUrl?: string;
  }

  const locationEntries = $derived.by((): LocEntry[] => {
    if (!ev?.locations) return [];
    return Object.values(ev.locations).map((loc) => {
      const label = loc.relativeTo === "start"
        ? "Departure"
        : loc.relativeTo === "end"
        ? "Arrival"
        : "Location";
      const instant = loc.relativeTo === "end" ? ev.utcEnd : ev.utcStart;
      const localTime = loc.timeZone && loc.timeZone !== BROWSER_TZ && !isAllDay
        ? `${fmtTimeInZone(new Date(instant), loc.timeZone)} local`
        : undefined;
      return {
        label,
        loc,
        localTime,
        mapUrl: loc.coordinates ? geoToMapUrl(loc.coordinates) : undefined,
      };
    });
  });

  const STATUS_GLYPH: Record<string, string> = {
    accepted: "✓",
    declined: "✕",
    tentative: "~",
    delegated: "→",
    "needs-action": "·",
  };

  interface PartEntry {
    display: string;
    status: string;
    glyph: string;
    isOwner: boolean;
  }

  function participantDisplay(id: string, p: EventParticipant): PartEntry {
    const addr = normalize.participantAddress(id, p as never);
    return {
      display: p.name || addr.email || addr.calendarAddress || "(unknown)",
      status: p.participationStatus ?? "needs-action",
      glyph: STATUS_GLYPH[p.participationStatus ?? "needs-action"] ?? "·",
      isOwner: p.roles?.owner === true,
    };
  }

  const participants = $derived.by((): PartEntry[] => {
    if (!ev?.participants) return [];
    return Object.entries(ev.participants)
      .map(([id, p]) => participantDisplay(id, p))
      .toSorted((a, b) => Number(b.isOwner) - Number(a.isOwner));
  });

  const organizer = $derived.by(() => {
    if (!ev) return undefined;
    const addr = normalize.organizer(ev as unknown as TypedEvent).calendarAddress;
    return addr?.replace(/^mailto:/i, "");
  });

  const alertLines = $derived.by((): string[] => {
    if (!ev) return [];
    if (ev.useDefaultAlerts) return ["Calendar default reminders"];
    if (!ev.alerts) return [];
    return Object.values(ev.alerts).map((a) => {
      const t = a.trigger;
      if (t?.["@type"] === "AbsoluteTrigger" && t.when) {
        return new Date(t.when).toLocaleString();
      }
      if (t?.offset) return humanizeOffset(t.offset, t.relativeTo);
      return "reminder";
    });
  });

  const calendarNames = $derived.by(() => {
    if (!ev) return [];
    return Object.keys(ev.calendarIds)
      .map((id) => app.calendars.find((c) => c.id === id)?.name)
      .filter((name): name is string => !!name);
  });

  // --- positioning ------------------------------------------------------------------------

  const PANEL_W = 340;
  const MARGIN = 8;

  const panelStyle = $derived.by(() => {
    const maxH = Math.min(Math.round(globalThis.innerHeight * 0.78), 600);
    const a = pop.anchor;
    if (!a) {
      return `left:50%;top:12vh;transform:translateX(-50%);max-height:${maxH}px;width:min(${PANEL_W}px, calc(100vw - 16px))`;
    }
    let left = a.x + a.w + 10;
    if (left + PANEL_W + MARGIN > globalThis.innerWidth) left = a.x - PANEL_W - 10;
    left = Math.max(MARGIN, Math.min(left, globalThis.innerWidth - PANEL_W - MARGIN));
    const top = Math.max(MARGIN, Math.min(a.y - 24, globalThis.innerHeight - maxH - MARGIN));
    return `left:${left}px;top:${top}px;max-height:${maxH}px;width:min(${PANEL_W}px, calc(100vw - 16px))`;
  });

  function onBackdropKey(e: KeyboardEvent) {
    if (e.key === "Escape") closePopover();
  }
</script>

{#if pop.kind !== "closed"}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="backdrop" onclick={closePopover} onkeydown={onBackdropKey}></div>

  {#if pop.kind === "event" && ev && range}
    <section
      class="panel"
      style={panelStyle}
      role="dialog"
      aria-label={ev.title || "Event details"}
      style:--ev={pop.evColor}
    >
      <header>
        <span class="swatch" aria-hidden="true"></span>
        <div class="head-main">
          <h2 class:cancelled={ev.status === "cancelled"}>{ev.title || "(untitled)"}</h2>
          <p class="when">
            {range.day} · {range.time}
            {#if ev.recurrenceId}<span class="recur" title="Part of a recurring series">⟳</span
              >{/if}
          </p>
          {#if zonedTime}<p class="zoned">{zonedTime}</p>{/if}
        </div>
        <button class="btn icon close" onclick={closePopover} aria-label="Close">✕</button>
      </header>

      {#if ev.isDraft || ev.status !== "confirmed" || ev.privacy === "private" || ev.privacy === "secret" || ev.freeBusyStatus === "free"}
        <div class="badges">
          {#if ev.isDraft}<span class="badge">draft</span>{/if}
          {#if ev.status === "tentative"}<span class="badge">tentative</span>{/if}
          {#if ev.status === "cancelled"}<span class="badge alert">cancelled</span>{/if}
          {#if ev.privacy === "private" || ev.privacy === "secret"}
            <span class="badge">🔒 {ev.privacy}</span>
          {/if}
          {#if ev.freeBusyStatus === "free"}<span class="badge">shows as free</span>{/if}
        </div>
      {/if}

      <div class="body">
        {#if ev.virtualLocations}
          {#each Object.values(ev.virtualLocations) as vl, i (i)}
            {#if vl.uri}
              <div class="row">
                <span class="row-icon" aria-hidden="true">🎥</span>
                <div>
                  <a class="join" href={vl.uri} target="_blank" rel="noopener noreferrer">
                    Join {vl.name || "video call"}
                  </a>
                  {#if vl.description}<p class="soft">{vl.description}</p>{/if}
                </div>
              </div>
            {/if}
          {/each}
        {/if}

        {#each locationEntries as entry, i (i)}
          <div class="row">
            <span class="row-icon" aria-hidden="true">📍</span>
            <div>
              <p class="row-title">
                {#if entry.label !== "Location"}<span class="loc-label">{entry.label}</span
                  >{/if}
                {entry.loc.name || "(unnamed place)"}
                {#if entry.localTime}<span class="loc-time">{entry.localTime}</span>{/if}
              </p>
              {#if entry.loc.description}<p class="soft clamp">{entry.loc.description}</p>{/if}
              <p class="loc-links">
                {#if entry.mapUrl}
                  <a href={entry.mapUrl} target="_blank" rel="noopener noreferrer">Map</a>
                {/if}
                {#each Object.values(entry.loc.links ?? {}) as link, j (j)}
                  {#if link.href}
                    <a href={link.href} target="_blank" rel="noopener noreferrer">
                      {link.title || link.rel || "link"}
                    </a>
                  {/if}
                {/each}
              </p>
            </div>
          </div>
        {/each}

        {#if ev.links && Object.values(ev.links).some((l) => l.href)}
          <div class="row">
            <span class="row-icon" aria-hidden="true">📎</span>
            <p class="loc-links">
              {#each Object.values(ev.links) as link, i (i)}
                {#if link.href}
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.title || link.rel || "attachment"}
                  </a>
                {/if}
              {/each}
            </p>
          </div>
        {/if}

        {#if participants.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true">👥</span>
            <div>
              {#if organizer}<p class="soft">Organized by {organizer}</p>{/if}
              <ul class="people">
                {#each participants as p, i (i)}
                  <li>
                    <span class="rsvp rsvp-{p.status}" title={p.status}>{p.glyph}</span>
                    {p.display}
                    {#if p.isOwner}<span class="owner">organizer</span>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          </div>
        {/if}

        {#if descriptionText}
          <div class="row">
            <span class="row-icon" aria-hidden="true">≡</span>
            <p class="desc">
              {#each linkify(descriptionText) as part, i (i)}
                {#if part.isUrl}
                  <a href={part.text} target="_blank" rel="noopener noreferrer">{part.text}</a>
                {:else}{part.text}{/if}
              {/each}
            </p>
          </div>
        {/if}

        {#if ev.keywords}
          <div class="row">
            <span class="row-icon" aria-hidden="true">#</span>
            <p class="tags">
              {#each Object.keys(ev.keywords) as kw (kw)}<span class="tag">{kw}</span>{/each}
            </p>
          </div>
        {/if}

        {#if alertLines.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true">🔔</span>
            <p class="soft">{alertLines.join(" · ")}</p>
          </div>
        {/if}
      </div>

      {#if calendarNames.length}
        <footer>
          <span class="swatch small" aria-hidden="true"></span>
          {calendarNames.join(", ")}
        </footer>
      {/if}
    </section>
  {:else if pop.kind === "day"}
    <section class="panel day" style={panelStyle} role="dialog" aria-label={pop.dayLabel}>
      <header>
        <div class="head-main"><h2>{pop.dayLabel}</h2></div>
        <button class="btn icon close" onclick={closePopover} aria-label="Close">✕</button>
      </header>
      <div class="body">
        <ul class="day-list">
          {#each pop.dayItems as item (item.ev.id)}
            <li>
              <button
                class="day-item"
                style:--ev={item.color}
                onclick={(e) => openEvent(item.ev, item.color, e.currentTarget)}
              >
                <span class="dot" aria-hidden="true"></span>
                <span class="di-time">
                  {item.ev.showWithoutTime
                    ? "all day"
                    : fmtTimeInZone(new Date(item.ev.utcStart), BROWSER_TZ)}
                </span>
                <span class="di-title" class:cancelled={item.ev.status === "cancelled"}>
                  {item.ev.title || "(untitled)"}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {/if}
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }

  .panel {
    position: fixed;
    z-index: 41;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    display: flex;
    gap: 0.6rem;
    padding: 0.9rem 0.9rem 0.5rem;
    align-items: flex-start;
  }

  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    background: var(--ev);
    flex-shrink: 0;
    margin-top: 4px;
  }

  .swatch.small {
    width: 9px;
    height: 9px;
    margin: 0;
  }

  .head-main {
    flex: 1;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: 1.02rem;
    font-weight: 700;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  h2.cancelled {
    text-decoration: line-through;
    opacity: 0.75;
  }

  .when {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    color: var(--ink-soft);
  }

  .recur {
    margin-left: 0.3rem;
    color: var(--amber);
    font-weight: 700;
  }

  .zoned {
    margin: 0.1rem 0 0;
    font-size: 0.75rem;
    color: var(--ink-faint);
  }

  .close {
    flex-shrink: 0;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding: 0 0.9rem 0.35rem;
  }

  .badge {
    font-size: 0.68rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    color: var(--ink-soft);
    background: var(--panel);
  }

  .badge.alert {
    color: var(--now);
    border-color: color-mix(in oklab, var(--now) 40%, var(--line));
  }

  .body {
    overflow-y: auto;
    padding: 0.35rem 0.9rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .row {
    display: flex;
    gap: 0.6rem;
    font-size: 0.85rem;
    min-width: 0;
  }

  .row-icon {
    flex-shrink: 0;
    width: 1.2rem;
    text-align: center;
    color: var(--ink-soft);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .row > div,
  .row > p {
    min-width: 0;
    flex: 1;
  }

  .row p {
    margin: 0;
  }

  .row-title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .loc-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--sky);
    margin-right: 0.35rem;
  }

  .loc-time {
    margin-left: 0.4rem;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--amber);
    white-space: nowrap;
  }

  .soft {
    color: var(--ink-soft);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .loc-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.7rem;
    font-size: 0.8rem;
    margin-top: 0.15rem;
  }

  a {
    color: var(--sky);
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  a:hover {
    text-decoration: underline;
  }

  .join {
    display: inline-block;
    background: var(--ev);
    color: var(--ground);
    font-weight: 600;
    border-radius: 6px;
    padding: 0.3rem 0.7rem;
    font-size: 0.82rem;
  }

  .join:hover {
    text-decoration: none;
    filter: brightness(1.06);
  }

  .people {
    list-style: none;
    margin: 0.15rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .people li {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    overflow-wrap: anywhere;
  }

  .rsvp {
    width: 1rem;
    text-align: center;
    font-weight: 700;
    flex-shrink: 0;
  }

  .rsvp-accepted {
    color: var(--good, #4a7a4e);
  }

  .rsvp-declined {
    color: var(--now);
  }

  .rsvp-tentative,
  .rsvp-needs-action {
    color: var(--ink-faint);
  }

  .owner {
    font-size: 0.65rem;
    color: var(--ink-faint);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 0.35rem;
  }

  .desc {
    white-space: pre-wrap;
    line-height: 1.5;
    font-size: 0.83rem;
    overflow-wrap: anywhere;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .tag {
    font-size: 0.7rem;
    background: color-mix(in oklab, var(--ev, var(--amber)) 14%, var(--panel));
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.55rem 0.9rem;
    border-top: 1px solid var(--line);
    font-size: 0.78rem;
    color: var(--ink-soft);
  }

  /* Day-overflow mode */
  .day-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .day-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.4rem;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .day-item:hover {
    background: color-mix(in oklab, var(--ink) 6%, transparent);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ev);
    flex-shrink: 0;
    align-self: center;
  }

  .di-time {
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    font-size: 0.75rem;
    width: 4.2rem;
  }

  .di-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .di-title.cancelled {
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>
