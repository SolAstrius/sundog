<script lang="ts">
  import { onMount } from "svelte";
  import { logout } from "../auth/oauth.ts";
  import { buildColorMap, calendarColor, eventColor } from "../lib/colors.ts";
  import {
    addDays,
    addMonths,
    dateKey,
    fmtMonthTitle,
    fmtWeekTitle,
    parseDateKey,
    startOfWeek,
  } from "../lib/dates.ts";
  import { navigate, route } from "../lib/router.svelte.ts";
  import {
    app,
    applyRoute,
    initApp,
    pathFor,
    refreshAll,
    stopPolling,
    toggleCalendar,
    type ViewKind,
  } from "../state/app.svelte.ts";
  import EventPopover from "./EventPopover.svelte";
  import MiniMonth from "./MiniMonth.svelte";
  import MonthView from "./MonthView.svelte";
  import { closePopover, openEvent, pop } from "./popover.svelte.ts";
  import WeekView from "./WeekView.svelte";

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
    const ev = app.events.find((e) => e.id === id);
    if (ev) openEvent(ev, eventColor(ev, buildColorMap(app.calendars)));
  });

  const anchorDate = $derived(parseDateKey(app.anchor));
  const title = $derived(
    app.view === "week" ? fmtWeekTitle(startOfWeek(anchorDate)) : fmtMonthTitle(anchorDate),
  );
  const userInitial = $derived((app.username || "?").slice(0, 1).toUpperCase());

  function go(anchor: Date, view: ViewKind = app.view) {
    navigate(pathFor(view, dateKey(anchor)));
  }

  function goToday() {
    go(new Date());
  }

  function goPrev() {
    go(app.view === "week" ? addDays(anchorDate, -7) : addMonths(anchorDate, -1));
  }

  function goNext() {
    go(app.view === "week" ? addDays(anchorDate, 7) : addMonths(anchorDate, 1));
  }

  function setView(view: ViewKind) {
    go(anchorDate, view);
  }

  function signOut() {
    stopPolling();
    logout();
    navigate("/login", true);
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (pop.kind !== "closed") {
        closePopover();
        e.preventDefault();
      }
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
    >☰</button>
    <button class="brand" onclick={goToday} title="Sundog — go to today">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="name">Sundog</span>
    </button>
    <button class="btn" onclick={goToday}>Today</button>
    <div class="chevrons">
      <button class="btn icon" onclick={goPrev} aria-label="Previous {app.view}">‹</button>
      <button class="btn icon" onclick={goNext} aria-label="Next {app.view}">›</button>
    </div>
    <h1 class="title">{title}</h1>
    {#if app.loading}
      <span class="pulse" title="Refreshing…" aria-hidden="true"></span>
    {/if}
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="View">
      <button aria-pressed={app.view === "week"} onclick={() => setView("week")}>Week</button>
      <button aria-pressed={app.view === "month"} onclick={() => setView("month")}>Month</button>
    </div>
    <details class="user">
      <summary aria-label="Account menu">{userInitial}</summary>
      <div class="menu">
        <p class="who">{app.username || "Signed in"}</p>
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

  <div class="body">
    {#if sidebarOpen}
      <aside>
        <MiniMonth />
        <section class="cals">
          <h2>Calendars</h2>
          {#each app.calendars as cal, i (cal.id)}
            <label class="cal">
              <input
                type="checkbox"
                checked={!app.hiddenCalendars[cal.id]}
                onchange={() => toggleCalendar(cal.id)}
                style:--c={calendarColor(cal, i)}
              />
              <span class="cal-name">{cal.name}</span>
              {#if cal.isDefault}<span class="default-tag">default</span>{/if}
            </label>
          {/each}
        </section>
        <footer class="hints">
          <kbd>t</kbd> today · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>w</kbd>/<kbd>m</kbd> view
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
      {:else}
        <MonthView />
      {/if}
    </main>
  </div>

  <EventPopover />
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
