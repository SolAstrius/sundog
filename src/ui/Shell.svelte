<script lang="ts">
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Lock from "@lucide/svelte/icons/lock";
  import Menu from "@lucide/svelte/icons/menu";
  import SearchIcon from "@lucide/svelte/icons/search";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import { onMount } from "svelte";
  import { logout } from "../auth/oauth.ts";
  import { buildColorMap, calendarColor, eventColor } from "../lib/colors.ts";
  import {
    addDays,
    addMonths,
    dateKey,
    fmtMonthTitle,
    fmtRangeTitle,
    fmtWeekTitle,
    parseDateKey,
    startOfWeek,
  } from "../lib/dates.ts";
  import { fmtDayLong } from "../lib/format.ts";
  import { navigate, route } from "../lib/router.svelte.ts";
  import {
    app,
    applyRoute,
    initApp,
    pathFor,
    refreshAll,
    stepAnchor,
    stopPolling,
    toggleCalendar,
    toggleKeywordFilter,
    type ViewKind,
  } from "../state/app.svelte.ts";
  import { deleteInstance, eventWritable, mut, undoLast } from "../state/mutations.svelte.ts";
  import { persistSettings, settings } from "../state/settings.svelte.ts";
  import AgendaView from "./AgendaView.svelte";
  import EventEditor from "./EventEditor.svelte";
  import EventPopover from "./EventPopover.svelte";
  import MiniMonth from "./MiniMonth.svelte";
  import MonthView from "./MonthView.svelte";
  import NowBar from "./NowBar.svelte";
  import PlannerView from "./PlannerView.svelte";
  import { closePopover, openEditor, openEvent, pop } from "./popover.svelte.ts";
  import SearchPanel from "./SearchPanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import UndoToast from "./UndoToast.svelte";
  import WeekView from "./WeekView.svelte";
  import WriteDialog from "./WriteDialog.svelte";
  import YearView from "./YearView.svelte";

  let initError = $state("");
  // Overlay sidebar (narrow screens) starts closed; docked sidebar starts open.
  let sidebarOpen = $state(globalThis.innerWidth > 760);

  // URL is the source of truth for view + anchor; unknown paths get canonicalized.
  $effect(() => {
    if (!applyRoute(route.path)) navigate(pathFor(app.view, app.anchor), true);
  });

  onMount(() => {
    initApp().catch((err) => {
      initError = err instanceof Error ? err.message : String(err);
    });
    return () => stopPolling();
  });

  // Deep link: ?open=<event id> opens the detail popover once the window is loaded.
  let deepLinkDone = false;
  $effect(() => {
    if (deepLinkDone || !app.ready || app.events.length === 0) return;
    const id = new URLSearchParams(location.search).get("open");
    deepLinkDone = true;
    if (!id) return;
    // Expanded instances carry synthetic ids even for non-recurring events; accept base ids too.
    const ev = app.events.find((e) => e.id === id || e.baseEventId === id);
    if (ev) openEvent(ev, eventColor(ev, buildColorMap(app.calendars)));
  });

  const anchorDate = $derived(parseDateKey(app.anchor));
  const title = $derived.by(() => {
    switch (app.view) {
      case "month":
        return fmtMonthTitle(anchorDate);
      case "agenda":
        return fmtRangeTitle(anchorDate, addDays(anchorDate, app.agendaDays - 1));
      case "year":
        return String(anchorDate.getFullYear());
      case "planner":
        return fmtDayLong(anchorDate);
      default:
        return fmtWeekTitle(startOfWeek(anchorDate));
    }
  });
  const userInitial = $derived((app.username || "?").slice(0, 1).toUpperCase());

  let searchOpen = $state(false);
  let settingsOpen = $state(false);

  /** Keyword chips harvested from the loaded window (top 12 by frequency). */
  const keywordCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const ev of app.events) {
      for (const kw of Object.keys(ev.keywords ?? {})) {
        counts.set(kw, (counts.get(kw) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  });

  function go(anchor: Date, view: ViewKind = app.view) {
    navigate(pathFor(view, dateKey(anchor)));
  }

  function goToday() {
    go(new Date());
  }

  function goPrev() {
    go(stepAnchor(-1));
  }

  function goNext() {
    go(stepAnchor(1));
  }

  function setView(view: ViewKind) {
    go(anchorDate, view);
  }

  function signOut() {
    stopPolling();
    logout();
    navigate("/login", true);
  }

  /** New event via `c`: next hour when today is in view, otherwise noon on the anchor day. */
  function openCreateDefault() {
    const now = new Date();
    const anchorD = parseDateKey(app.anchor);
    const todayInView = dateKey(now) === app.anchor ||
      (app.view === "week" && startOfWeek(now).getTime() === startOfWeek(anchorD).getTime());
    const start = todayInView ? new Date(now) : new Date(anchorD);
    start.setMinutes(0, 0, 0);
    if (todayInView) start.setHours(start.getHours() + 1);
    else start.setHours(12);
    openEditor({ startMs: start.getTime(), endMs: start.getTime() + 3_600_000, allDay: false });
  }

  function editOpenEvent() {
    const ev = pop.ev;
    if (pop.kind !== "event" || !ev || !eventWritable(ev)) return;
    const startMs = new Date(ev.utcStart).getTime();
    const endMs = new Date(ev.utcEnd).getTime();
    const allDay = ev.showWithoutTime || endMs - startMs >= 86_400_000;
    openEditor({ ev, startMs, endMs, allDay }, pop.anchor);
  }

  async function deleteOpenEvent() {
    const ev = pop.ev;
    if (pop.kind !== "event" || !ev || !eventWritable(ev) || mut.busy) return;
    if (await deleteInstance(ev)) closePopover();
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (mut.dialog) return; // the write dialog owns the keyboard
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      void undoLast();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (pop.kind !== "closed") closePopover();
      else if (searchOpen) searchOpen = false;
      else if (settingsOpen) settingsOpen = false;
      else return;
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "t":
        goToday();
        break;
      case "j":
      case "n":
        goNext();
        break;
      case "k":
      case "p":
        goPrev();
        break;
      case "w":
        setView("week");
        break;
      case "m":
        setView("month");
        break;
      case "a":
        setView("agenda");
        break;
      case "y":
        setView("year");
        break;
      case "d":
        setView("planner");
        break;
      case "c":
        openCreateDefault();
        break;
      case "e":
        editOpenEvent();
        break;
      case "Delete":
      case "Backspace":
        if (pop.kind !== "event") return;
        void deleteOpenEvent();
        break;
      case "z":
        void undoLast();
        break;
      case "/":
        searchOpen = true;
        break;
      case "r":
        void refreshAll();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header>
    <button
      class="btn icon"
      onclick={() => (sidebarOpen = !sidebarOpen)}
      aria-label="Toggle sidebar"
      aria-expanded={sidebarOpen}
    ><Menu size={17} /></button>
    <button class="brand" onclick={goToday} title="Sundog — go to today">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="name">Sundog</span>
    </button>
    <button class="btn" onclick={goToday}>Today</button>
    <div class="chevrons">
      <button class="btn icon" onclick={goPrev} aria-label="Previous {app.view}">
        <ChevronLeft size={17} />
      </button>
      <button class="btn icon" onclick={goNext} aria-label="Next {app.view}">
        <ChevronRight size={17} />
      </button>
    </div>
    <h1 class="title">{title}</h1>
    {#if app.loading}
      <span class="pulse" title="Refreshing…" aria-hidden="true"></span>
    {/if}
    <div class="spacer"></div>
    <button class="btn icon" onclick={() => (searchOpen = true)} aria-label="Search ( / )">
      <SearchIcon size={16} />
    </button>
    <div class="seg" role="group" aria-label="View">
      <button aria-pressed={app.view === "week"} onclick={() => setView("week")}>Week</button>
      <button aria-pressed={app.view === "month"} onclick={() => setView("month")}>Month</button>
      <button aria-pressed={app.view === "agenda"} onclick={() => setView("agenda")}>
        Agenda
      </button>
      <button aria-pressed={app.view === "year"} onclick={() => setView("year")}>Year</button>
      <button aria-pressed={app.view === "planner"} onclick={() => setView("planner")}>
        Day
      </button>
    </div>
    <details class="user">
      <summary aria-label="Account menu">{userInitial}</summary>
      <div class="menu">
        <p class="who">{app.username || "Signed in"}</p>
        {#if app.identities.length}
          <p class="who-detail">
            {app.identities[0].replace(/^mailto:/i, "")}
            {#if app.identities.length > 1}(+{app.identities.length - 1} more){/if}
          </p>
        {/if}
        <p class="who-detail">account {app.accountId} · {Intl.DateTimeFormat().resolvedOptions()
            .timeZone}</p>
        <button
          class="btn"
          onclick={(e) => {
            settingsOpen = true;
            (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
          }}
        ><SettingsIcon size={13} /> Settings</button>
        <button class="btn" onclick={signOut}>Sign out</button>
      </div>
    </details>
  </header>

  {#if app.error}
    <div class="toast" role="alert">
      <span>{app.error}</span>
      <button class="btn" onclick={() => void refreshAll()}>Retry</button>
    </div>
  {/if}

  {#if app.ready}
    <NowBar />
  {/if}

  <div class="body">
    {#if sidebarOpen}
      <aside>
        <MiniMonth />
        <section class="cals">
          <h2>Calendars</h2>
          {#each app.calendars as cal, i (cal.id)}
            <label
              class="cal"
              title={[
                cal.description,
                cal.timeZone ? `Zone: ${cal.timeZone}` : "",
                cal.myRights ? `Rights: ${Object.keys(cal.myRights).filter((r) => cal.myRights![r]).join(", ")}` : "",
              ].filter(Boolean).join("\n") || cal.name}
            >
              <input
                type="checkbox"
                checked={!app.hiddenCalendars[cal.id]}
                onchange={() => toggleCalendar(cal.id)}
                style:--c={calendarColor(cal, i)}
              />
              <span class="cal-name">{cal.name}</span>
              {#if cal.myRights && cal.myRights.mayWriteAll === false}
                <span class="ro" title="Read-only for you"><Lock size={10} /></span>
              {/if}
              {#if cal.isDefault}<span class="default-tag">default</span>{/if}
            </label>
          {/each}
        </section>
        <section class="cals">
          <h2>Filters</h2>
          {#if keywordCounts.length}
            <div class="kw-chips">
              {#each keywordCounts as [kw, count] (kw)}
                <button
                  class="kw"
                  class:active={app.filters.keywords[kw]}
                  onclick={() => toggleKeywordFilter(kw)}
                >
                  {kw} <span class="kw-n">{count}</span>
                </button>
              {/each}
            </div>
          {/if}
          <label class="cal">
            <input type="checkbox" bind:checked={app.filters.showTentative} />
            <span class="cal-name">Tentative</span>
          </label>
          <label class="cal">
            <input type="checkbox" bind:checked={app.filters.showCancelled} />
            <span class="cal-name">Cancelled</span>
          </label>
          <label class="cal">
            <input type="checkbox" bind:checked={app.filters.showDrafts} />
            <span class="cal-name">Drafts</span>
          </label>
          <label class="cal">
            <input type="checkbox" bind:checked={app.filters.showFree} />
            <span class="cal-name">Free (non-blocking)</span>
          </label>
          <label class="cal">
            <input
              type="checkbox"
              bind:checked={settings.showDeclined}
              onchange={persistSettings}
            />
            <span class="cal-name">Declined by you</span>
          </label>
        </section>
        <footer class="hints">
          <kbd>c</kbd> new · <kbd>e</kbd> edit · <kbd>z</kbd> undo · <kbd>t</kbd> today ·
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>w</kbd>
          <kbd>m</kbd> <kbd>a</kbd> <kbd>y</kbd> <kbd>d</kbd> views · <kbd>/</kbd> search
        </footer>
      </aside>
    {/if}
    <main>
      {#if initError}
        <div class="center-note" role="alert">
          <h2>Couldn't load your calendars</h2>
          <p>{initError}</p>
          <button
            class="btn primary"
            onclick={() => {
              initError = "";
              initApp().catch((err) => {
                initError = err instanceof Error ? err.message : String(err);
              });
            }}
          >Try again</button>
        </div>
      {:else if !app.ready}
        <div class="center-note">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <p>Loading your calendars…</p>
        </div>
      {:else if app.view === "week"}
        <WeekView />
      {:else if app.view === "agenda"}
        <AgendaView />
      {:else if app.view === "year"}
        <YearView />
      {:else if app.view === "planner"}
        <PlannerView />
      {:else}
        <MonthView />
      {/if}
    </main>
  </div>

  <EventPopover />
  <EventEditor />
  <WriteDialog />
  <UndoToast />
  {#if searchOpen}
    <SearchPanel onclose={() => (searchOpen = false)} />
  {/if}
  {#if settingsOpen}
    <SettingsPanel onclose={() => (settingsOpen = false)} />
  {/if}
</div>

<style>
  .shell {
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
  }

  .brand .name {
    font-weight: 700;
    font-size: 1.05rem;
    letter-spacing: -0.01em;
  }

  .chevrons {
    display: flex;
    gap: 0.25rem;
  }

  .title {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0 0 0 0.3rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--amber);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }

  .spacer {
    flex: 1;
  }

  .user {
    position: relative;
  }

  .user summary {
    list-style: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--sky);
    color: var(--ground);
    font-weight: 700;
    display: grid;
    place-items: center;
    cursor: pointer;
    user-select: none;
  }

  .user summary::-webkit-details-marker {
    display: none;
  }

  .user .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.8rem;
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    z-index: 30;
  }

  .who {
    margin: 0;
    font-weight: 600;
    word-break: break-all;
  }

  .who-detail {
    margin: 0;
    font-size: 0.72rem;
    color: var(--ink-faint);
    word-break: break-all;
  }

  .ro {
    color: var(--ink-faint);
    display: inline-flex;
    flex-shrink: 0;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    justify-content: center;
    padding: 0.5rem 0.9rem;
    background: color-mix(in oklab, var(--now) 12%, var(--panel));
    border-bottom: 1px solid var(--line);
    font-size: 0.85rem;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  aside {
    width: 15.5rem;
    flex-shrink: 0;
    border-right: 1px solid var(--line);
    background: var(--panel);
    padding: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    overflow-y: auto;
  }

  .cals h2 {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink-soft);
    margin: 0 0 0.5rem;
  }

  .cal {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.28rem 0.2rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .cal:hover {
    background: color-mix(in oklab, var(--ink) 5%, transparent);
  }

  .cal input {
    appearance: none;
    width: 15px;
    height: 15px;
    border-radius: 4px;
    border: 2px solid var(--c, var(--amber));
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .cal input:checked {
    background: var(--c, var(--amber));
  }

  .cal input:checked::after {
    content: "";
    width: 4px;
    height: 7px;
    border: solid var(--ground);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg) translateY(-1px);
  }

  .cal-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .default-tag {
    font-size: 0.65rem;
    color: var(--ink-faint);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 0.4rem;
  }

  .kw-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.5rem;
  }

  .kw {
    font-size: 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.08rem 0.55rem;
    color: var(--ink-soft);
    cursor: pointer;
  }

  .kw:hover {
    border-color: var(--amber);
    color: var(--ink);
  }

  .kw.active {
    background: var(--amber);
    border-color: var(--amber);
    color: var(--amber-ink);
    font-weight: 600;
  }

  .kw-n {
    opacity: 0.65;
    font-size: 0.62rem;
  }

  .hints {
    margin-top: auto;
    color: var(--ink-faint);
    font-size: 0.72rem;
  }

  kbd {
    font-family: inherit;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 0.25rem;
    background: var(--raised);
  }

  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .center-note {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.7rem;
    color: var(--ink-soft);
    text-align: center;
    padding: 2rem;
  }

  .center-note h2 {
    margin: 0;
    color: var(--ink);
    font-size: 1.1rem;
  }

  .center-note p {
    margin: 0;
    max-width: 30rem;
  }

  @media (max-width: 760px) {
    aside {
      position: fixed;
      z-index: 20;
      top: 53px;
      bottom: 0;
      left: 0;
      box-shadow: var(--shadow);
    }

    .title {
      font-size: 0.9rem;
    }
  }
</style>
