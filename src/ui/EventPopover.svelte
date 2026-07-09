<script lang="ts">
  import AlignLeft from "@lucide/svelte/icons/align-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Bell from "@lucide/svelte/icons/bell";
  import Check from "@lucide/svelte/icons/check";
  import Circle from "@lucide/svelte/icons/circle";
  import CircleHelp from "@lucide/svelte/icons/circle-help";
  import Download from "@lucide/svelte/icons/download";
  import FileText from "@lucide/svelte/icons/file-text";
  import Hash from "@lucide/svelte/icons/hash";
  import LinkIcon from "@lucide/svelte/icons/link";
  import Lock from "@lucide/svelte/icons/lock";
  import MapPin from "@lucide/svelte/icons/map-pin";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Repeat from "@lucide/svelte/icons/repeat";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Users from "@lucide/svelte/icons/users";
  import Video from "@lucide/svelte/icons/video";
  import X from "@lucide/svelte/icons/x";
  import type {
    BaseEventDetails,
    EventAlert,
    EventInstance,
    EventLink,
    EventLocation,
    EventParticipant,
  } from "../jmap/calendar.ts";
  import { fetchBaseEvents, fetchEventByUid } from "../jmap/calendar.ts";
  import { stalwartProvider } from "../core/provider/stalwart.ts";
  import type { TypedEvent } from "../core/schemas/jscalendar.ts";
  import { downloadBlob, fetchBlobObjectUrl, fmtBytes } from "../jmap/blob.ts";
  import { fmtSecondary } from "../lib/altcal.ts";
  import { BROWSER_TZ } from "../lib/dates.ts";
  import {
    directionsUrl,
    fmtRange,
    fmtTimeInZone,
    geoToLatLon,
    geoToMapUrl,
    htmlToText,
    humanizeOffset,
    linkify,
  } from "../lib/format.ts";
  import { cachedGeocode, geocode, type GeoPoint } from "../lib/geocode.ts";
  import LocationMap, { type MapPoint } from "./LocationMap.svelte";
  import { downloadIcs } from "../lib/ics.ts";
  import { describeRecurrence } from "../lib/recurrence.ts";
  import { app, ownParticipationStatus } from "../state/app.svelte.ts";
  import { deleteInstance, eventWritable, mut } from "../state/mutations.svelte.ts";
  import { buildColorMap, eventColor } from "../lib/colors.ts";
  import { closePopover, openEditor, openEvent, pop } from "./popover.svelte.ts";

  const normalize = stalwartProvider().normalize;

  // --- M1 write verbs -------------------------------------------------------------------------

  const writable = $derived(pop.ev ? eventWritable(pop.ev) : false);

  function editThis(): void {
    const current = pop.ev;
    if (!current) return;
    const startMs = new Date(current.utcStart).getTime();
    const endMs = new Date(current.utcEnd).getTime();
    const allDay = current.showWithoutTime || endMs - startMs >= 86_400_000;
    openEditor({ ev: current, startMs, endMs, allDay }, pop.anchor);
  }

  async function deleteThis(): Promise<void> {
    const current = pop.ev;
    if (!current || mut.busy) return;
    if (await deleteInstance(current)) closePopover();
  }

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

  // --- localizations: language pills swap title/description --------------------------------

  let lang = $state("");
  $effect(() => {
    void ev;
    lang = "";
  });

  const langs = $derived(Object.keys(ev?.localizations ?? {}));

  function localized(field: "title" | "description"): string | undefined {
    if (!lang || !ev?.localizations?.[lang]) return undefined;
    const value = ev.localizations[lang][field];
    return typeof value === "string" ? value : undefined;
  }

  const displayTitle = $derived(localized("title") ?? ev?.title ?? "");

  const descriptionText = $derived.by(() => {
    const raw = localized("description") ?? ev?.description;
    if (!raw) return "";
    return ev?.descriptionContentType === "text/html" ? htmlToText(raw) : raw;
  });

  // --- recurrence: lazy base fetch → human text, modified badge, series nav ------------------

  let base = $state<BaseEventDetails | undefined>(undefined);
  $effect(() => {
    const current = ev;
    base = undefined;
    if (!current?.baseEventId || !current.recurrenceId) return;
    fetchBaseEvents(app.accountId, [current.baseEventId])
      .then((bases) => {
        if (pop.ev === current) base = bases[0];
      })
      .catch(() => {});
  });

  /** Hybrid: RFC 8984 plural arrays OR the bis singular objects Stalwart serves. */
  const recurrenceLines = $derived.by(() => {
    if (!base) return [];
    const rules = base.recurrenceRules ?? (base.recurrenceRule ? [base.recurrenceRule] : undefined);
    const excluded = base.excludedRecurrenceRules ??
      (base.excludedRecurrenceRule ? [base.excludedRecurrenceRule] : undefined);
    return describeRecurrence(rules, excluded, base.recurrenceOverrides);
  });

  /** Override patch for THIS occurrence (non-empty and not exclusion-only ⇒ "modified"). */
  const occurrencePatch = $derived.by(() => {
    if (!base || !ev?.recurrenceId) return undefined;
    const patch = base.recurrenceOverrides?.[ev.recurrenceId];
    if (!patch || patch.excluded === true) return undefined;
    const keys = Object.keys(patch).map((pointer) => pointer.split("/")[0]);
    return keys.length ? [...new Set(keys)] : undefined;
  });

  /** Window siblings of this series for prev/next hops. */
  const siblings = $derived.by(() => {
    if (!ev?.baseEventId || !ev.recurrenceId) return [];
    return app.events
      .filter((e) => e.baseEventId === ev.baseEventId)
      .toSorted((a, b) => a.utcStart.localeCompare(b.utcStart));
  });

  const siblingIndex = $derived(siblings.findIndex((e) => e.id === ev?.id));

  function hop(offset: number) {
    const target = siblings[siblingIndex + offset];
    if (target) openEvent(target, pop.evColor);
  }

  const relatedEntries = $derived.by(() => {
    const source = base?.relatedTo ?? ev?.relatedTo;
    if (!source) return [];
    return Object.entries(source).map(([uid, rel]) => ({
      uid,
      kind: Object.keys(rel?.relation ?? {}).join("/") || "related",
    }));
  });

  let relatedBusy = $state(false);
  async function openRelated(uid: string) {
    if (relatedBusy) return;
    relatedBusy = true;
    try {
      const found = await fetchEventByUid(app.accountId, uid, BROWSER_TZ);
      if (found) openEvent(found, eventColor(found, buildColorMap(app.calendars)));
    } finally {
      relatedBusy = false;
    }
  }

  // --- provenance ---------------------------------------------------------------------------

  function relTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.round(ms / 86_400_000);
    if (Math.abs(days) >= 30) return new Date(iso).toLocaleDateString();
    if (Math.abs(days) >= 1) return `${days} d ago`;
    const hours = Math.round(ms / 3_600_000);
    return hours >= 1 ? `${hours} h ago` : "just now";
  }

  const ownStatus = $derived(ev ? ownParticipationStatus(ev) : undefined);

  interface LocEntry {
    key: string;
    label: string;
    loc: EventLocation;
    /** Wall time at that location for its relativeTo instant (travel events). */
    localTime?: string;
    mapUrl?: string;
    directions?: string;
  }

  const locationEntries = $derived.by((): LocEntry[] => {
    if (!ev?.locations) return [];
    return Object.entries(ev.locations).map(([key, loc]) => {
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
        key,
        label,
        loc,
        localTime,
        mapUrl: loc.coordinates ? geoToMapUrl(loc.coordinates) : undefined,
        directions: directionsUrl(loc),
      };
    });
  });

  // --- map: coordinate pins + on-demand geocoded pins, row↔pin hover coordination -------------

  /** Per-location geocode state for entries without geo: coordinates. */
  let geocoded = $state<Record<string, GeoPoint | "pending" | "failed">>({});
  let hoveredLocKey = $state<string | null>(null);

  // New event → reset, then auto-pin places this browser has geocoded before (cache is sync).
  $effect(() => {
    const entries = locationEntries;
    const fresh: Record<string, GeoPoint | "pending" | "failed"> = {};
    for (const entry of entries) {
      if (entry.loc.coordinates || !entry.loc.name) continue;
      const hit = cachedGeocode(entry.loc.name);
      if (hit) fresh[entry.key] = hit;
    }
    geocoded = fresh;
    hoveredLocKey = null;
  });

  async function locate(entry: LocEntry): Promise<void> {
    const name = entry.loc.name;
    if (!name || geocoded[entry.key]) return;
    geocoded = { ...geocoded, [entry.key]: "pending" };
    const ll = await geocode(name);
    geocoded = { ...geocoded, [entry.key]: ll ?? "failed" };
  }

  const mapPoints = $derived.by((): MapPoint[] => {
    return locationEntries.flatMap((entry): MapPoint[] => {
      const base = { key: entry.key, label: entry.label, name: entry.loc.name };
      const ll = entry.loc.coordinates ? geoToLatLon(entry.loc.coordinates) : undefined;
      if (ll) return [{ ...base, ...ll }];
      const found = geocoded[entry.key];
      if (found && found !== "pending" && found !== "failed") return [{ ...base, ...found }];
      return [];
    });
  });

  // deno-lint-ignore no-explicit-any
  const RSVP_ICONS: Record<string, any> = {
    accepted: Check,
    declined: X,
    tentative: CircleHelp,
    delegated: ArrowRight,
    "needs-action": Circle,
  };

  interface PartEntry {
    display: string;
    status: string;
    isOwner: boolean;
    kind?: string;
    expectReply: boolean;
    comment?: string;
    delegatedTo: string[];
    deliveryFailed: boolean;
  }

  function participantName(id: string, p: EventParticipant | undefined): string {
    if (!p) return id;
    const addr = normalize.participantAddress(id, p as never);
    return p.name || addr.email || addr.calendarAddress || "(unknown)";
  }

  function participantDisplay(
    id: string,
    p: EventParticipant,
    all: Record<string, EventParticipant>,
  ): PartEntry {
    // iCal statcodes: 1.x pending, 2.x delivered — anything else is a delivery problem.
    const scheduleStatus = (p as { scheduleStatus?: string[] }).scheduleStatus ?? [];
    const deliveryFailed = scheduleStatus.some((code) => {
      const major = parseInt(code, 10);
      return Number.isFinite(major) && major >= 3;
    });
    return {
      display: participantName(id, p),
      status: p.participationStatus ?? "needs-action",
      isOwner: p.roles?.owner === true,
      kind: p.kind,
      expectReply: p.expectReply === true,
      comment: p.participationComment,
      delegatedTo: Object.keys(p.delegatedTo ?? {}).map((pid) => participantName(pid, all[pid])),
      deliveryFailed,
    };
  }

  const participants = $derived.by((): PartEntry[] => {
    if (!ev?.participants) return [];
    return Object.entries(ev.participants)
      .map(([id, p]) => participantDisplay(id, p, ev.participants!))
      .toSorted((a, b) => Number(b.isOwner) - Number(a.isOwner));
  });

  // --- nerd corner ---------------------------------------------------------------------------

  let copied = $state("");
  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => (copied = ""), 1500);
    } catch {
      // Clipboard denied — no-op.
    }
  }

  const rawJson = $derived.by(() =>
    ev ? JSON.stringify(base ? { instance: ev, base } : ev, null, 2) : ""
  );

  const organizer = $derived.by(() => {
    if (!ev) return undefined;
    const addr = normalize.organizer(ev as unknown as TypedEvent).calendarAddress;
    return addr?.replace(/^mailto:/i, "");
  });

  function describeAlert(a: EventAlert): string {
    const t = a.trigger;
    let line: string;
    if (t?.["@type"] === "AbsoluteTrigger" && t.when) line = new Date(t.when).toLocaleString();
    else if (t?.offset) line = humanizeOffset(t.offset, t.relativeTo);
    else line = "reminder";
    if (a.acknowledged) line += " (dismissed)";
    return line;
  }

  const alertLines = $derived.by((): string[] => {
    if (!ev) return [];
    if (ev.useDefaultAlerts) {
      // Resolve the calendar's actual defaults instead of a vague placeholder.
      const cal = app.calendars.find((c) => ev.calendarIds[c.id]);
      const defaults = isAllDay ? cal?.defaultAlertsWithoutTime : cal?.defaultAlertsWithTime;
      if (defaults && Object.keys(defaults).length) {
        return Object.values(defaults).map((a) => `${describeAlert(a)} (calendar default)`);
      }
      return ["Calendar default reminders"];
    }
    if (!ev.alerts) return [];
    return Object.values(ev.alerts).map(describeAlert);
  });

  const calendarNames = $derived.by(() => {
    if (!ev) return [];
    return Object.keys(ev.calendarIds)
      .map((id) => app.calendars.find((c) => c.id === id)?.name)
      .filter((name): name is string => !!name);
  });

  // --- attachments (file display) ---------------------------------------------------------

  interface Attachment {
    key: string;
    name: string;
    contentType?: string;
    size?: number;
    href?: string;
    blobId?: string;
    isImage: boolean;
  }

  /** Enclosures and blob-backed links are files; everything else with an href is a plain link. */
  const attachments = $derived.by((): Attachment[] => {
    if (!ev?.links) return [];
    return Object.entries(ev.links)
      .filter(([, l]) => l.blobId || l.rel === "enclosure")
      .map(([key, l]) => ({
        key,
        name: l.title || key,
        contentType: l.contentType ?? undefined,
        size: l.size,
        href: l.href,
        blobId: l.blobId ?? undefined,
        isImage: (l.contentType ?? "").startsWith("image/"),
      }));
  });

  const plainLinks = $derived.by((): EventLink[] => {
    if (!ev?.links) return [];
    return Object.values(ev.links).filter((l) => l.href && !l.blobId && l.rel !== "enclosure");
  });

  function linkDisplay(l: EventLink): string {
    if (l.title) return l.title;
    try {
      const u = new URL(l.href!);
      return u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 24) : "");
    } catch {
      return l.href ?? "link";
    }
  }

  /** Blob-image thumbnails, fetched with auth into object URLs; revoked when the event changes. */
  let thumbs = $state<Record<string, string>>({});
  $effect(() => {
    const atts = attachments;
    thumbs = {};
    let alive = true;
    const created: string[] = [];
    for (const att of atts) {
      if (!att.isImage || !att.blobId) continue;
      fetchBlobObjectUrl(app.accountId, att.blobId, att.name, att.contentType)
        .then((url) => {
          if (!alive) {
            URL.revokeObjectURL(url);
            return;
          }
          created.push(url);
          thumbs = { ...thumbs, [att.key]: url };
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      for (const url of created) URL.revokeObjectURL(url);
    };
  });

  let downloading = $state<Record<string, boolean>>({});
  async function download(att: Attachment): Promise<void> {
    if (!att.blobId || downloading[att.key]) return;
    downloading = { ...downloading, [att.key]: true };
    try {
      await downloadBlob(app.accountId, att.blobId, att.name, att.contentType);
    } catch {
      // Non-fatal: leave the button enabled for a retry.
    } finally {
      downloading = { ...downloading, [att.key]: false };
    }
  }

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
          <h2 class:cancelled={ev.status === "cancelled"}>{displayTitle || "(untitled)"}</h2>
          <p class="when">
            {range.day} · {range.time}
            {#if ev.recurrenceId}
              <span class="recur" title="Part of a recurring series"><Repeat size={12} /></span>
            {/if}
          </p>
          {#if zonedTime}<p class="zoned">{zonedTime}</p>{/if}
          {#if fmtSecondary(new Date(ev.utcStart), true)}
            <p class="zoned">{fmtSecondary(new Date(ev.utcStart), true)}</p>
          {/if}
          {#if langs.length}
            <p class="langs">
              <button class="lang" class:active={lang === ""} onclick={() => (lang = "")}>
                original
              </button>
              {#each langs as code (code)}
                <button class="lang" class:active={lang === code} onclick={() => (lang = code)}>
                  {code}
                </button>
              {/each}
            </p>
          {/if}
        </div>
        {#if writable}
          <button class="btn icon close" onclick={editThis} aria-label="Edit event" title="Edit (e)">
            <Pencil size={15} />
          </button>
          <button
            class="btn icon close"
            onclick={deleteThis}
            aria-label="Delete event"
            title="Delete"
            disabled={mut.busy}
          >
            <Trash2 size={15} />
          </button>
        {/if}
        <button class="btn icon close" onclick={closePopover} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {#if ev.isDraft || ev.status !== "confirmed" || ev.privacy === "private" || ev.privacy === "secret" || ev.freeBusyStatus === "free" || occurrencePatch || (ev.priority && ev.priority !== 0) || ownStatus === "declined" || ev.participants}
        <div class="badges">
          {#if ev.isDraft}<span class="badge">draft</span>{/if}
          {#if ev.status === "tentative"}<span class="badge">tentative</span>{/if}
          {#if ev.status === "cancelled"}<span class="badge alert">cancelled</span>{/if}
          {#if ev.privacy === "private" || ev.privacy === "secret"}
            <span class="badge"><Lock size={10} /> {ev.privacy}</span>
          {/if}
          {#if ev.freeBusyStatus === "free"}<span class="badge">shows as free</span>{/if}
          {#if occurrencePatch}
            <span
              class="badge amber"
              title="Changed vs the series: {occurrencePatch.join(', ')}"
            >modified occurrence</span>
          {/if}
          {#if ev.priority && ev.priority !== 0 && ev.priority !== 5}
            <span class="badge" class:alert={ev.priority <= 4}>
              {ev.priority <= 4 ? "high" : "low"} priority ({ev.priority})
            </span>
          {/if}
          {#if ownStatus === "declined"}<span class="badge">you declined</span>{/if}
          {#if ev.participants}
            <span class="badge">{ev.isOrigin ? "you organize this" : "invited copy"}</span>
          {/if}
        </div>
      {/if}

      <div class="body">
        {#if ev.recurrenceId && (recurrenceLines.length || siblings.length > 1 || relatedEntries.length)}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><Repeat size={15} /></span>
            <div>
              {#each recurrenceLines as line, i (i)}<p class="row-title rec">{line}</p>{/each}
              {#if siblings.length > 1 && siblingIndex >= 0}
                <p class="series-nav">
                  Occurrence {siblingIndex + 1} of {siblings.length} in view
                  {#if siblingIndex > 0}
                    · <button class="linkish" onclick={() => hop(-1)}>‹ prev</button>
                  {/if}
                  {#if siblingIndex < siblings.length - 1}
                    · <button class="linkish" onclick={() => hop(1)}>next ›</button>
                  {/if}
                </p>
              {/if}
              {#each relatedEntries as rel (rel.uid)}
                <p class="series-nav">
                  <button
                    class="linkish"
                    disabled={relatedBusy}
                    onclick={() => openRelated(rel.uid)}
                  >
                    {rel.kind === "first"
                      ? "continues an earlier series ›"
                      : rel.kind === "next"
                      ? "continued by a later series ›"
                      : `related series (${rel.kind}) ›`}
                  </button>
                </p>
              {/each}
            </div>
          </div>
        {/if}

        {#if ev.virtualLocations}
          {#each Object.values(ev.virtualLocations) as vl, i (i)}
            {#if vl.uri}
              <div class="row">
                <span class="row-icon" aria-hidden="true"><Video size={15} /></span>
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

        {#each locationEntries as entry (entry.key)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="row loc-row"
            class:hot={hoveredLocKey === entry.key}
            onmouseenter={() => (hoveredLocKey = entry.key)}
            onmouseleave={() => (hoveredLocKey = null)}
          >
            <span class="row-icon" aria-hidden="true"><MapPin size={15} /></span>
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
                {#if entry.directions}
                  <a href={entry.directions} target="_blank" rel="noopener noreferrer">
                    Directions
                  </a>
                {/if}
                {#if !entry.loc.coordinates && entry.loc.name && geocoded[entry.key] !== "failed"}
                  {@const found = geocoded[entry.key]}
                  {#if !found}
                    <button class="linkish" onclick={() => locate(entry)}>Show on map</button>
                  {:else if found === "pending"}
                    <span class="soft">Locating…</span>
                  {/if}
                {:else if geocoded[entry.key] === "failed"}
                  <span class="soft">Place not found</span>
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

        {#if mapPoints.length}
          <div class="map-row">
            <LocationMap
              points={mapPoints}
              highlightKey={hoveredLocKey}
              onHover={(key) => (hoveredLocKey = key)}
            />
          </div>
        {/if}

        {#if attachments.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><Paperclip size={15} /></span>
            <div class="atts">
              {#each attachments as att (att.key)}
                {#if att.isImage && (thumbs[att.key] || (att.href && !att.blobId))}
                  <button
                    class="att-img"
                    title={att.blobId ? `Download ${att.name}` : att.name}
                    onclick={() =>
                    att.blobId
                      ? download(att)
                      : globalThis.open(att.href, "_blank", "noopener")}
                  >
                    <img src={thumbs[att.key] ?? att.href} alt={att.name} loading="lazy" />
                    <span class="att-cap">
                      {att.name}{att.size ? ` · ${fmtBytes(att.size)}` : ""}
                    </span>
                  </button>
                {:else if att.blobId}
                  <button class="att" onclick={() => download(att)} disabled={downloading[att.key]}>
                    <Download size={13} />
                    <span class="att-name">
                      {downloading[att.key] ? "Downloading…" : att.name}
                    </span>
                    {#if att.size}<span class="att-size">{fmtBytes(att.size)}</span>{/if}
                  </button>
                {:else if att.href}
                  <a class="att" href={att.href} target="_blank" rel="noopener noreferrer">
                    <FileText size={13} />
                    <span class="att-name">{att.name}</span>
                  </a>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if plainLinks.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><LinkIcon size={15} /></span>
            <p class="loc-links">
              {#each plainLinks as link, i (i)}
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {linkDisplay(link)}
                </a>
              {/each}
            </p>
          </div>
        {/if}

        {#if participants.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><Users size={15} /></span>
            <div>
              {#if organizer}<p class="soft">Organized by {organizer}</p>{/if}
              <ul class="people">
                {#each participants as p, i (i)}
                  {@const RsvpIcon = RSVP_ICONS[p.status] ?? Circle}
                  <li>
                    <div class="person">
                      <span class="rsvp rsvp-{p.status}" title={p.status}>
                        <RsvpIcon size={12} />
                      </span>
                      {p.display}
                      {#if p.kind && p.kind !== "individual"}
                        <span class="owner">{p.kind}</span>
                      {/if}
                      {#if p.isOwner}<span class="owner">organizer</span>{/if}
                      {#if p.expectReply && p.status === "needs-action"}
                        <span class="owner amber-t">reply requested</span>
                      {/if}
                      {#if p.deliveryFailed}
                        <span class="owner fail">invitation undelivered</span>
                      {/if}
                    </div>
                    {#if p.delegatedTo.length}
                      <p class="p-note">delegated to {p.delegatedTo.join(", ")}</p>
                    {/if}
                    {#if p.comment}<p class="p-note">“{p.comment}”</p>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          </div>
        {/if}

        {#if descriptionText}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><AlignLeft size={15} /></span>
            <p class="desc">
              {#each linkify(descriptionText) as part, i (i)}
                {#if part.isUrl}
                  <a href={part.text} target="_blank" rel="noopener noreferrer">{part.text}</a>
                {:else}{part.text}{/if}
              {/each}
            </p>
          </div>
        {/if}

        {#if ev.keywords || ev.categories}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><Hash size={15} /></span>
            <p class="tags">
              {#each Object.keys(ev.keywords ?? {}) as kw (kw)}<span class="tag">{kw}</span
                >{/each}
              {#each Object.keys(ev.categories ?? {}) as cat (cat)}
                <span class="tag cat" title={cat}>{cat.split("/").filter(Boolean).pop()}</span>
              {/each}
            </p>
          </div>
        {/if}

        {#if alertLines.length}
          <div class="row">
            <span class="row-icon" aria-hidden="true"><Bell size={15} /></span>
            <p class="soft">{alertLines.join(" · ")}</p>
          </div>
        {/if}

        <details class="nerd">
          <summary>Details for nerds</summary>
          <div class="nerd-body">
            <p class="soft mono">
              {#if ev.created}created {relTime(ev.created)} ·{/if}
              {#if ev.updated}updated {relTime(ev.updated)} ·{/if}
              {#if ev.sequence !== undefined}seq {ev.sequence} ·{/if}
              id {ev.id}
            </p>
            <p class="nerd-actions">
              <button class="btn" onclick={() => downloadIcs(ev, base)}>Download .ics</button>
              <button class="btn" onclick={() => copy("uid", base?.uid ?? ev.baseEventId ?? "")}>
                {copied === "uid" ? "Copied" : "Copy UID"}
              </button>
              <button class="btn" onclick={() => copy("json", rawJson)}>
                {copied === "json" ? "Copied" : "Copy JSON"}
              </button>
            </p>
            <pre class="raw">{rawJson}</pre>
          </div>
        </details>
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
        <button class="btn icon close" onclick={closePopover} aria-label="Close">
          <X size={16} />
        </button>
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
    display: inline-flex;
    vertical-align: -1px;
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
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .badge.alert {
    color: var(--now);
    border-color: color-mix(in oklab, var(--now) 40%, var(--line));
  }

  .badge.amber {
    color: var(--amber);
    border-color: color-mix(in oklab, var(--amber) 45%, var(--line));
  }

  .langs {
    margin: 0.25rem 0 0;
    display: flex;
    gap: 0.25rem;
  }

  .lang {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 0.45rem;
    color: var(--ink-soft);
    cursor: pointer;
  }

  .lang.active {
    background: var(--sky);
    border-color: var(--sky);
    color: var(--ground);
  }

  .rec {
    font-weight: 500;
  }

  .series-nav {
    color: var(--ink-soft);
    font-size: 0.78rem;
    margin-top: 0.15rem;
  }

  .linkish {
    color: var(--sky);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
  }

  .linkish:hover {
    text-decoration: underline;
  }

  .linkish:disabled {
    opacity: 0.6;
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
    display: flex;
    justify-content: center;
    color: var(--ink-soft);
    padding-top: 0.15rem;
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
    line-clamp: 3;
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

  /* Align the inline map with row content (icon column + gap). */
  .map-row {
    margin: -0.25rem 0 0 1.8rem;
  }

  /* Row ↔ pin hover coordination */
  .loc-row {
    border-radius: 6px;
    margin: 0 -0.3rem;
    padding: 0 0.3rem;
    transition: background 0.12s;
  }

  .loc-row.hot {
    background: color-mix(in oklab, var(--ev, var(--amber)) 9%, transparent);
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
    overflow-wrap: anywhere;
  }

  .person {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .p-note {
    margin: 0 0 0 1.45rem;
    color: var(--ink-faint);
    font-size: 0.74rem;
    font-style: italic;
  }

  .owner.amber-t {
    color: var(--amber);
    border-color: color-mix(in oklab, var(--amber) 45%, var(--line));
  }

  .owner.fail {
    color: var(--now);
    border-color: color-mix(in oklab, var(--now) 45%, var(--line));
  }

  .rsvp {
    width: 1rem;
    display: inline-flex;
    justify-content: center;
    align-self: center;
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

  .atts {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: flex-start;
  }

  .att {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 0.3rem 0.6rem;
    background: var(--panel);
    color: var(--ink);
    cursor: pointer;
    max-width: 100%;
  }

  .att:hover {
    border-color: color-mix(in oklab, var(--ev, var(--amber)) 45%, var(--line));
    text-decoration: none;
  }

  .att:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .att-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-size {
    color: var(--ink-faint);
    font-size: 0.72rem;
    flex-shrink: 0;
  }

  .att-img {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.3rem;
    background: var(--panel);
    cursor: pointer;
    max-width: 100%;
  }

  .att-img:hover {
    border-color: color-mix(in oklab, var(--ev, var(--amber)) 45%, var(--line));
  }

  .att-img img {
    max-width: 16rem;
    max-height: 9rem;
    object-fit: cover;
    border-radius: 5px;
    display: block;
  }

  .att-cap {
    font-size: 0.7rem;
    color: var(--ink-soft);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 16rem;
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

  .tag.cat {
    background: color-mix(in oklab, var(--sky) 14%, var(--panel));
  }

  .nerd {
    border-top: 1px dashed var(--line);
    padding-top: 0.45rem;
  }

  .nerd summary {
    font-size: 0.72rem;
    color: var(--ink-faint);
    cursor: pointer;
    user-select: none;
  }

  .nerd-body {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding-top: 0.45rem;
  }

  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem;
  }

  .nerd-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin: 0;
  }

  .raw {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.5rem;
    font-size: 0.62rem;
    line-height: 1.45;
    max-height: 14rem;
    overflow: auto;
    margin: 0;
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
