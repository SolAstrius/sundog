# Sundog — a JMAP-native calendar app

Status: idea/design draft (2026-07-08). Grounded in the Letterdog rfc-notes
(draft-ietf-jmap-calendars-26, RFC 8984, RFC 9670, RFC 9404) and live probes against
`mail.astrius.ink` (Stalwart v0.16.11) run the same day.

**Sundog** (a parhelion — the bright halo companion of the sun): sibling of Letterdog, same
astronomy family. Alternates considered: Ephemeris, Analemma, Orrery.

## Thesis

Google Calendar's moat is interaction quality — speed, drag-and-drop, undo, find-a-time — not its
data model. JSCalendar + JMAP calendars is a strictly richer model than Google's API (real time
zones, structured recurrence overrides, per-user properties on shared events, drafts, non-Gregorian
recurrence). So the plan is:

1. **Match the UX bar** Google set (instant, direct-manipulation, keyboard-first, undo-everything).
2. **Win on the model** — ship features Google structurally cannot express.
3. **Win on ownership** — self-hosted, provider-agnostic (any JMAP server), agent-native
   (Letterdog MCP/CLI operate on the same live state).

## Verified foundation (probed 2026-07-08)

| Probe | Result | Consequence |
|---|---|---|
| CORS preflight (`Origin: https://cal.astrius.ink`) | `access-control-allow-origin: *`, methods GET/POST/OPTIONS, headers `*` | The browser can speak JMAP to Stalwart directly — no proxy needed |
| OAuth metadata | `authorization_code` + PKCE S256 + `refresh_token` + device code at `mail.astrius.ink/login`, `/auth/token` | Real login flow in the SPA; no bearer paste |
| Session capabilities | `calendars`, `calendars:parse`, `principals`, `principals:availability`, `contacts`, `blob`, `mail`, `submission`, `websocket` | Everything the app needs from one server |
| Push | `eventSourceUrl` present; WebSocket `wss://mail.astrius.ink/jmap/ws` with `supportsPush: true` | Live multi-device updates without polling |
| Limits | `maxExpandedQueryDuration: P52W1D`, `maxObjectsInGet: 500`, `maxParticipantsPerEvent: 20`, upload 50 MB, `mayCreateCalendar: true` | Server-side recurrence expansion covers even a year view |

Headline consequence: **zero-backend architecture is viable.** The entire deployment is a static
SPA; an optional sidecar appears only for phase-4 features that need a server (public booking
pages, ICS feed ingestion).

## Architecture

```
cal.astrius.ink (static SPA, k8s mail-and-pim, image via registry.sol.moe)
        │  OAuth PKCE (login/refresh against Stalwart)
        ▼
  jmap-sync client ──── WebSocket push (StateChange → delta fetch)
        │                    │
  IndexedDB replica     /changes per type
        │
  view layer (custom CSS-grid calendar engine)
```

- **`jmap-sync`** is the heart: session cache, batched requests with back-references, per-type
  stores (Calendar, CalendarEvent, CalendarEventNotification, ShareNotification, Principal) driven
  by `/changes`, WebSocket `StateChange` push, IndexedDB persistence for instant first paint, an
  optimistic mutation queue, and an inverse-patch undo log.
- **Reuse Letterdog core**: the Zod JSCalendar schemas and the Stalwart hybrid-shape normalizers
  (`calendarAddress` vs `sendTo`, `replyTo` map vs `organizerCalendarAddress`, unknown `roles`
  keys) already exist in `stalwart-jmap-mcp/src/core/`. Share them as a package (JSR or workspace);
  Sundog is effectively Letterdog's third surface, with its own live-sync layer.
- **Recurrence — hybrid strategy**: every calendar view has bounds, and the server expands
  recurrences for windows up to a year (`expandRecurrences: true` + both bounds). Use
  server-expanded windows, cached per window; the **synthetic instance ids** the server returns are
  exactly the trap-free write path for "edit just this occurrence". A client-side JSCalendar
  expansion engine is deferred to the offline milestone.
- **Time math**: Temporal (polyfill where needed), never `Date`. JSCalendar's
  `LocalDateTime + timeZone` maps 1:1 onto `Temporal.PlainDateTime`/`ZonedDateTime`.
- **Rendering**: custom CSS-grid day/week engine and virtualized month/agenda — FullCalendar-style
  libraries cap the ceiling and fight the "ultimate" bar.
- **Framework**: Svelte 5 or Solid (fine-grained reactivity suits a store-driven live grid);
  TypeScript end to end; Vite static build.

## UX pillars (the Google-parity bar)

1. **Instant.** First paint from the IndexedDB replica, no skeletons; optimistic writes reconcile
   against server state.
2. **Views.** Day / N-day / week / month / year / agenda; mini-month navigator; calendar overlay
   toggles; Google-compatible keyboard map (`c` create, `e` edit, `/` search, `t` today, `j`/`k`
   page, `1–6` switch views).
3. **Direct manipulation.** Drag-create, drag-move, edge-resize, cross-day drag, 15-minute snap,
   ghost preview while dragging.
4. **Undo everything.** Every mutation logs its inverse PatchObject; one toast, one keystroke back.
5. **Quick add.** Natural-language parse (chrono-node) with a typed preview before commit; an LLM
   path can come later via Letterdog.
6. **"Send updates to guests?"** maps exactly to `sendSchedulingMessages` (spec default `false`).
   The app never silently spams attendees and never silently desyncs them — it surfaces the choice
   the way Google does, but honestly.
7. **Recurrence scope dialog** — "this event / this and following / all events" — implemented
   honestly: this event = synthetic-id write; this-and-following = documented split-series pattern
   (truncate rule with `until`, create successor, link via `relatedTo` first/next); all = base id.

## Where it beats Google (spec superpowers)

- **Time zones as first-class.** Per-event zones, floating events, a dual-zone ribbon, and travel
  events: one event, two Locations with `relativeTo: start/end` and the arrival location's own
  `timeZone` — flights render with both local times. Google cannot express this.
- **Drafts.** `isDraft: true` events are pencil-ins guaranteed to emit no scheduling messages.
- **Per-user properties on shared calendars.** Your color, your alerts, your keywords on a shared
  event — spec-native (`mayUpdatePrivate`), not a hack.
- **Keywords, priority, freeBusyStatus, full-text search** (`text` filter is server-side) → saved
  filters and smart views Google doesn't have.
- **A real change feed.** CalendarEventNotification records who changed what — render "Daria moved
  Standup 10:00 → 11:00" from the actual `eventPatch` diff; dismiss by destroying the notification.
  ShareNotification does the same for sharing changes.
- **Find-a-time** over `Principal/getAvailability`: availability grid across family members and
  resources (principals on the same server), honoring `includeInAvailability` and the
  confirmed > unavailable > tentative precedence.
- **Per-occurrence RSVP.** Decline just Tuesday's instance — an override patching your own
  participant's `participationStatus`.
- **Non-Gregorian recurrence.** `rscale` Hebrew/Islamic/Chinese with leap months and `skip` —
  birthdays and holidays Google structurally cannot recur correctly.
- **Self-hosted and provider-agnostic.** No data mining; points at any JMAP calendar server
  (Fastmail, Cyrus) via the same provider-adapter philosophy as Letterdog.
- **Agent-native.** Letterdog MCP/CLI and Sundog share one live server state; Sundog exposes deep
  links (`…/event/<id>`) agents can emit; an embedded assistant panel is a natural later step.

## Traps designed around (from rfc-notes, verified live)

1. **`updateScope`/`destroyScope` do not exist.** Stalwart silently ignores unknown `/set` args —
   a client that "scopes" an edit actually rewrites the whole series. Only three real paths:
   synthetic-id writes, `recurrenceOverrides` patches, split-series.
2. **Query semantics:** `after` compares against event *end*, `before` against event *start*
   (overlap semantics), both LocalDateTime in the query's `timeZone`.
3. `expandRecurrences` requires both bounds; window ≤ `maxExpandedQueryDuration` (P52W1D here).
4. `utcStart`/`utcEnd` are fetch-time computed and mutually exclusive with fetching
   `recurrenceOverrides` — display-list use only.
5. `isDefault` changes only via `onSuccessSetIsDefault`, which **fails silently** — re-read to
   verify.
6. Free-busy-only shared calendars are invisible to `Calendar/get` — absence ≠ nonexistence in
   availability UI.
7. Stalwart v0.16 serves an RFC 8984 / JSCalendar-bis **hybrid** (bis `calendarAddress` on
   participants, 8984 `replyTo` map on events, nonstandard `roles` like `required`) — normalize
   both shapes (Letterdog's normalizers), re-verify on server upgrades.
8. **No iTIP COUNTER** in the draft — "propose a new time" can only be a mail reply, not a
   structured counter. Known limitation; surface it as such.
9. `maxParticipantsPerEvent: 20` — enforce in the invite UI before the server bounces it.

## Milestones

1. **M0 — Shell (read-only).** OAuth PKCE login; calendar list with colors; week + month views fed
   by expanded window queries; live refresh via state polling (30s + on tab focus) — probed
   2026-07-08: Stalwart accepts neither WebSocket nor EventSource auth via query param, and
   browsers can't set the Authorization header on either, so real push waits for a sidecar or
   upstream cookie/param auth support; deployed static at `cal.astrius.ink`.
2. **M1 — Writes.** Create/edit/delete for non-recurring events; drag/resize; optimistic queue +
   undo; quick add; event detail panel.
3. **M2 — Recurrence & scheduling.** Recurrence editor; the scope dialog; RSVP including
   per-occurrence; invitations with the send-updates choice; notification feed; search.
4. **M3 — Sharing & presence.** `shareWith` editor over the CalendarRights matrix; find-a-time;
   default alerts + snooze; web-push reminders (verify Stalwart PushSubscription support here);
   offline PWA with client-side expansion.
5. **M4 — Moonshots.** Public booking pages (first sidecar need); webcal/ICS feed subscriptions
   (sidecar cron); travel-event UI; LLM quick add; embedded agent panel; multi-account.

## Open questions

- Name: Sundog vs Ephemeris vs Analemma (repo seeded as `sundog`; `mv` is cheap).
- Framework: Svelte 5 vs Solid — both fit; pick by taste at M0 kickoff.
- How Letterdog core is shared: JSR package vs workspace vs copy-first-extract-later (the
  Letterdog v2 doc's own "no speculative framework" rule suggests copy-first).
- PushSubscription (RFC 8620 §7.2 web push) support in Stalwart — probe at M3, not assumed.
- Repo home: `~/repos/own/infra/` (seeded there, next to `stalwart-jmap-mcp`) vs an apps area.
