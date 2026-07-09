<script lang="ts">
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import { addDays, dateKey, parseDateKey } from "../lib/dates.ts";
  import { calendarColor } from "../lib/colors.ts";
  import { geoToLatLon } from "../lib/format.ts";
  import { geocode } from "../lib/geocode.ts";
  import LocationMap, { type MapPoint } from "./LocationMap.svelte";
  import { app } from "../state/app.svelte.ts";
  import {
    calendarWritable,
    createFromEditor,
    deleteInstance,
    mut,
    saveFromEditor,
  } from "../state/mutations.svelte.ts";
  import { closePopover, pop } from "./popover.svelte.ts";

  const seed = $derived(pop.edit);
  const editing = $derived(seed?.ev);
  const recurring = $derived(!!seed?.ev?.recurrenceId);
  const hasGuests = $derived(
    !!seed?.ev?.participants && Object.keys(seed.ev.participants).length > 1,
  );

  const writableCals = $derived(app.calendars.filter((c) => calendarWritable(c.id)));

  let title = $state("");
  let allDay = $state(false);
  let startDate = $state("");
  let startTime = $state("");
  let endDate = $state("");
  let endTime = $state("");
  let calendarId = $state("");
  let locationName = $state("");
  /** geo: URI from the map picker ("" = no pin). */
  let locationCoords = $state("");
  /** Pointless picker view after a failed geocode — lets the pin be placed by hand. */
  let pickerFallback = $state<{ lat: number; lon: number; zoom: number } | undefined>();
  let geoBusy = $state(false);
  let geoMiss = $state(false);
  let description = $state("");
  let error = $state("");
  let titleInput: HTMLInputElement | undefined = $state();
  /** Pre-change start instant, captured on focus for duration-preserving shifts. */
  let lastStartMs = 0;

  const pad = (n: number) => String(n).padStart(2, "0");
  const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // Re-seed the form whenever the editor opens on a different target.
  $effect(() => {
    const s = pop.edit;
    if (!s) return;
    const ev = s.ev;
    title = ev?.title ?? "";
    allDay = s.allDay;
    const start = new Date(s.startMs);
    const end = new Date(s.endMs);
    startDate = dateKey(start);
    startTime = timeOf(start);
    if (s.allDay) {
      // Exclusive end → inclusive display date.
      endDate = dateKey(addDays(new Date(s.endMs - 1), 0));
      endTime = timeOf(start);
    } else {
      endDate = dateKey(end);
      endTime = timeOf(end);
    }
    const defaultCal = app.calendars.find((c) => c.isDefault && calendarWritable(c.id)) ??
      writableCals[0];
    calendarId = (ev ? Object.keys(ev.calendarIds)[0] : undefined) ?? defaultCal?.id ?? "";
    const loc = Object.values(ev?.locations ?? {})[0];
    locationName = loc?.name ?? "";
    locationCoords = loc?.coordinates && geoToLatLon(loc.coordinates) ? loc.coordinates : "";
    pickerFallback = undefined;
    geoBusy = false;
    geoMiss = false;
    description = ev?.description ?? "";
    error = "";
    lastStartMs = s.startMs;
    setTimeout(() => titleInput?.focus(), 0);
  });

  // --- location map picker --------------------------------------------------------------------

  const pickerPoints = $derived.by((): MapPoint[] => {
    const ll = locationCoords ? geoToLatLon(locationCoords) : undefined;
    return ll
      ? [{ key: "l1", label: "Location", name: locationName.trim() || undefined, ...ll }]
      : [];
  });

  async function findOnMap(): Promise<void> {
    if (geoBusy || !locationName.trim()) return;
    geoBusy = true;
    geoMiss = false;
    try {
      const ll = await geocode(locationName);
      if (ll) {
        locationCoords = `geo:${ll.lat},${ll.lon}`;
        pickerFallback = undefined;
      } else {
        geoMiss = true;
        // No match: open the map wide anyway so the pin can be dropped manually.
        pickerFallback = { lat: 48, lon: 15, zoom: 3 };
      }
    } finally {
      geoBusy = false;
    }
  }

  function onPick(lat: number, lon: number): void {
    locationCoords = `geo:${lat},${lon}`;
    geoMiss = false;
  }

  function clearPin(): void {
    locationCoords = "";
    pickerFallback = undefined;
    geoMiss = false;
  }

  function parseLocal(date: string, time: string): number {
    const d = parseDateKey(date);
    const [hh = 0, mm = 0] = time.split(":").map(Number);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
  }

  /** Moving the start drags the end along (duration-preserving, Google-style). */
  function onStartChange(prevStartMs: number): void {
    if (!startDate || !prevStartMs) return;
    const durMs = parseLocal(endDate, endTime) - prevStartMs;
    if (durMs <= 0 || durMs > 32 * 86_400_000) return;
    const next = new Date(parseLocal(startDate, startTime) + durMs);
    endDate = dateKey(next);
    endTime = timeOf(next);
  }

  function formInstants(): { startMs: number; endMs: number } | undefined {
    if (!startDate || !endDate) {
      error = "Pick a date";
      return undefined;
    }
    if (allDay) {
      const startMs = parseLocal(startDate, "00:00");
      const endMs = parseLocal(endDate, "00:00") + 86_400_000; // inclusive → exclusive
      if (endMs <= startMs) {
        error = "End date is before the start";
        return undefined;
      }
      return { startMs, endMs };
    }
    const startMs = parseLocal(startDate, startTime);
    const endMs = parseLocal(endDate, endTime);
    if (endMs <= startMs) {
      error = "End is before the start";
      return undefined;
    }
    return { startMs, endMs };
  }

  async function save(): Promise<void> {
    if (mut.busy) return;
    const instants = formInstants();
    if (!instants) return;
    error = "";
    const input = {
      title,
      calendarId,
      allDay,
      ...instants,
      description,
      locationName,
      locationCoordinates: locationCoords,
    };
    const ok = editing ? await saveFromEditor(editing, input) : await createFromEditor(input);
    if (ok) closePopover();
  }

  async function remove(): Promise<void> {
    if (!editing || mut.busy) return;
    if (await deleteInstance(editing)) closePopover();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      void save();
    }
  }

  // --- positioning (same recipe as EventPopover) ---------------------------------------------

  const PANEL_W = 380;
  const MARGIN = 8;

  const panelStyle = $derived.by(() => {
    const maxH = Math.min(Math.round(globalThis.innerHeight * 0.85), 620);
    const a = pop.anchor;
    if (!a) {
      return `left:50%;top:10vh;transform:translateX(-50%);max-height:${maxH}px;width:min(${PANEL_W}px, calc(100vw - 16px))`;
    }
    let left = a.x + a.w + 10;
    if (left + PANEL_W + MARGIN > globalThis.innerWidth) left = a.x - PANEL_W - 10;
    left = Math.max(MARGIN, Math.min(left, globalThis.innerWidth - PANEL_W - MARGIN));
    const top = Math.max(MARGIN, Math.min(a.y - 24, globalThis.innerHeight - maxH - MARGIN));
    return `left:${left}px;top:${top}px;max-height:${maxH}px;width:min(${PANEL_W}px, calc(100vw - 16px))`;
  });
</script>

{#if pop.kind === "edit" && seed}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="backdrop" onclick={closePopover}></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_element_to_interactive_role -->
  <section
    class="panel"
    style={panelStyle}
    role="dialog"
    aria-label={editing ? "Edit event" : "New event"}
    onkeydown={onKeydown}
  >
    <header>
      <h2>{editing ? "Edit event" : "New event"}</h2>
      <button class="btn icon" onclick={closePopover} aria-label="Close"><X size={16} /></button>
    </header>

    <div class="body">
      <input
        class="title"
        type="text"
        placeholder="Add title"
        bind:value={title}
        bind:this={titleInput}
      />

      {#if recurring}
        <p class="note">Series event — you'll choose “this event / all events” when saving.</p>
      {/if}
      {#if hasGuests}
        <p class="note">Has guests — you'll be asked whether to notify them.</p>
      {/if}

      <div class="times">
        <label class="field">
          <span>Starts</span>
          <span class="pair">
            <input
              type="date"
              bind:value={startDate}
              onfocus={() => (lastStartMs = parseLocal(startDate, startTime))}
              onchange={() => onStartChange(lastStartMs)}
            />
            {#if !allDay}
              <input
                type="time"
                step="900"
                bind:value={startTime}
                onfocus={() => (lastStartMs = parseLocal(startDate, startTime))}
                onchange={() => onStartChange(lastStartMs)}
              />
            {/if}
          </span>
        </label>
        <label class="field">
          <span>Ends</span>
          <span class="pair">
            <input type="date" bind:value={endDate} />
            {#if !allDay}<input type="time" step="900" bind:value={endTime} />{/if}
          </span>
        </label>
        <label class="allday">
          <input type="checkbox" bind:checked={allDay} disabled={recurring} />
          All day{recurring ? " (fixed for series events)" : ""}
        </label>
      </div>

      <label class="field">
        <span>Calendar</span>
        <select bind:value={calendarId} disabled={recurring && !!editing}>
          {#each writableCals as cal, i (cal.id)}
            <option value={cal.id}>{cal.name}</option>
          {/each}
        </select>
      </label>

      <div class="field">
        <span>Location</span>
        <input
          type="text"
          placeholder="Add location"
          bind:value={locationName}
          oninput={() => (geoMiss = false)}
        />
        <p class="loc-actions">
          {#if locationName.trim() && !locationCoords}
            <button class="linkish" onclick={findOnMap} disabled={geoBusy}>
              {geoBusy ? "Locating…" : "Find on map"}
            </button>
          {/if}
          {#if locationCoords}
            <button class="linkish" onclick={findOnMap} disabled={geoBusy || !locationName.trim()}>
              {geoBusy ? "Locating…" : "Re-find"}
            </button>
            <button class="linkish" onclick={clearPin}>Remove pin</button>
          {/if}
          {#if geoMiss}<span class="miss">No match — click the map to place the pin</span>{/if}
        </p>
        {#if pickerPoints.length || pickerFallback}
          <LocationMap points={pickerPoints} onPick={onPick} center={pickerFallback} />
        {/if}
      </div>

      <label class="field">
        <span>Notes</span>
        <textarea rows="3" placeholder="Add description" bind:value={description}></textarea>
      </label>

      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>

    <footer>
      {#if editing}
        <button class="btn danger" onclick={remove} disabled={mut.busy} title="Delete event">
          <Trash2 size={14} /> Delete
        </button>
      {/if}
      <span class="spacer"></span>
      <button class="btn" onclick={closePopover}>Cancel</button>
      <button class="btn primary" onclick={save} disabled={mut.busy}>
        {editing ? "Save" : "Create"}
      </button>
    </footer>
  </section>
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
    align-items: center;
    justify-content: space-between;
    padding: 0.8rem 0.9rem 0.4rem;
  }

  h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
  }

  .body {
    overflow-y: auto;
    padding: 0.2rem 0.9rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .title {
    font-size: 1.05rem;
    font-weight: 600;
    border: none;
    border-bottom: 2px solid var(--line);
    background: transparent;
    padding: 0.3rem 0.1rem;
    color: var(--ink);
  }

  .title:focus {
    outline: none;
    border-bottom-color: var(--amber);
  }

  .note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--amber);
  }

  .times {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
  }

  .field > span:first-child {
    color: var(--ink-soft);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .pair {
    display: flex;
    gap: 0.4rem;
  }

  .pair input[type="date"] {
    flex: 1;
  }

  input[type="date"],
  input[type="time"],
  select,
  textarea,
  input[type="text"]:not(.title) {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 0.35rem 0.5rem;
    color: var(--ink);
    font-size: 0.85rem;
    font-family: inherit;
  }

  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--amber) 55%, transparent);
    outline-offset: 1px;
  }

  .allday {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: var(--ink-soft);
    cursor: pointer;
  }

  textarea {
    resize: vertical;
    min-height: 3.2rem;
  }

  .error {
    margin: 0;
    color: var(--now);
    font-size: 0.78rem;
  }

  .loc-actions {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    font-size: 0.74rem;
    min-height: 0;
  }

  .loc-actions:empty {
    display: none;
  }

  .linkish {
    color: var(--sky);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    background: none;
    border: none;
  }

  .linkish:hover {
    text-decoration: underline;
  }

  .linkish:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .miss {
    color: var(--amber);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.6rem 0.9rem 0.8rem;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }

  .btn.danger {
    color: var(--now);
    border-color: color-mix(in oklab, var(--now) 40%, var(--line));
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .btn.danger:hover {
    background: color-mix(in oklab, var(--now) 10%, transparent);
  }
</style>
