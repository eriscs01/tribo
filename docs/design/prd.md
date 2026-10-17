# Tribo — PRD

Oct 16, 2026 · @Eris Sales

## Overview

Tribo holds every part of a group trip — transport, stays, activities, money, documents and to-dos — and serves it three ways: a web app for people, a REST API for apps, and an MCP server for AI assistants. Every record is owned, permissioned and audited.

It is self-hosted, single-tenant software for personal and group use: one instance, one platform admin, no billing.

**Why "Tribo".** *Tribo* is the Tagalog word for "tribe", borrowed from Spanish *tribu* (Latin *tribus*). The name maps to the product in three ways:

- **The group is the unit.** A trip is organised by a tribe — family or barkada — so shared items, roles and settle-up are built around the group, not a solo traveler.
- **Each member keeps their own place in it.** Like any tribe, members share a common life but keep their own belongings: the personal "My trip" view and private items.
- **A tribe outlasts one journey.** The same people, places, vendors and templates carry into the next trip, which is the reusability goal.

The opening letters also echo "trip", which keeps the name easy to recall.

**Problem.** Group trip details are scattered across booking emails, Facebook pages, chats and spreadsheets. Nobody has one current view, personal to-dos get lost in group threads, and nothing records who changed what.

**Goals**

- One source of truth per trip, covering every trip aspect (see Functional requirements).
- Each member sees the trip from their own perspective: shared group items plus private items only they track.
- Reuse across trips: people, places, vendors, packing lists and templates carry over to the next trip.
- Parity across Web, API and MCP — anything a person can do, an app or an AI can do under the same permissions.
- A full audit trail on every record: what changed, when, by whom, and through which surface.

**Non-goals (v1)**

- Booking or payment processing, including GCash/Maya settle-up (the platform records bookings and payments; it does not make them).
- Public trip marketplace, social feed, multi-tenant SaaS or billing.
- Native mobile apps (responsive web + PWA first; the API enables apps later).
- Real-time flight status ingestion (manual entry or a later integration).

## Personas and roles

Permissions combine a platform role (one per account) with a trip role (one per trip membership); the stricter rule wins.

| Role | Scope | Can do |
| --- | --- | --- |
| Platform admin | Whole platform | Maintain user accounts and issue password-reset links, reference data (places, vendors, templates), restore deleted records, view audit metadata (private-item details need break-glass), manage the MCP client allowlist; set document retention; approve destructive AI actions |
| Trip owner | One trip | Everything on the trip; invite/remove members; assign trip roles; archive or clone the trip |
| Trip organizer | One trip | Create and edit shared items; assign tasks; edit or void any expense |
| Trip member | One trip | View shared items; edit items assigned to them; add expenses; manage own private items; RSVP to activities |
| Viewer / guest | One trip | Read-only shared view (e.g. family at home); no private items, no costs unless granted |
| Service account | API / MCP | Deferred past MVP: the MCP server acts as the signed-in user, and scripts use personal access tokens |

Per-field visibility: sensitive fields (booking refs, passport data, card last-4, individual costs) are hidden from Viewers by default and can be restricted further per item.

## Domain model

Reusability comes from splitting long-lived library records from per-trip instances: a trip references library records instead of copying them, so the next trip starts with places, vendors, people and templates already in place.

| Layer | Entity | Purpose | Reused across trips |
| --- | --- | --- | --- |
| Library | Person / Traveler profile | Name, contacts, ID/passport (encrypted), dietary needs, emergency contact | Yes |
| Library | Place | Destination, beach, landmark, port, airport — with geo, hours, notes, photos | Yes |
| Library | Vendor | Airline, guest house, tour operator, rental, ferry line — contacts and links | Yes |
| Library | Template | Trip skeleton, packing list, checklist, budget categories | Yes |
| Trip | Trip | Name, dates, destination(s), currency, timezone, status (draft → planning → active → completed → archived) | Cloned |
| Trip | Membership | Person + trip role + room/vehicle assignment | Per trip |
| Trip | Item (polymorphic) | Transport segment, Lodging, Activity, Ground transport, Meal, Task, Note, Document | Per trip; can save as template |
| Trip | Expense / Settlement | Who paid, split rules, balances, settle-up | Per trip |
| Cross-cutting | Visibility | `shared` (group) or `private` (owner only), optional per-user share | — |
| Cross-cutting | Audit event | Immutable change record for every entity | — |

**Item common fields:** id, trip, type, title, start/end (with timezone), place, vendor, status, cost + currency + payer, attachments, tags, assignees, visibility, owner, version, created/updated/deleted metadata.

**Clone a trip:** copies structure (items, checklists, budget categories, roles) with dates shifted relative to a new start date; drops bookings, refs, payments, files and private items; the owner can opt in to copy only their own private items.

## Functional requirements

P0 = MVP for the reference trip; P1 = next release; P2 = later.

| ID | Module | Requirement | Priority |
| --- | --- | --- | --- |
| F-01 | Trips | Create, edit, archive, clone trips; trip dashboard with countdown, next item, open tasks, balance | P0 |
| F-02 | Members | Shareable invite link per trip (expiry, max uses, revocable): new users create their account from it, existing users join; accept/decline; assign trip role; per-member room, vehicle, seat assignment | P0 |
| F-03 | Transport | Flights, ferries, buses, vans: carrier, number, depart/arrive place + time (local TZ), booking ref, fare rules (refundable/changeable), baggage allowance and add-ons, per-passenger tickets | P0 |
| F-04 | Lodging | Property, rooms, capacity, bed type, nightly rate, check-in/out, occupant assignment, deposit/balance due | P0 |
| F-05 | Ground transport | Rentals (e-bikes, scooters, vans), drivers, licence requirement, pickup/return, fuel/charge notes | P0 |
| F-06 | Itinerary | Day-by-day timeline merging all dated items; conflict and gap detection (e.g. overlapping items, no transfer between airport and port) | P0 |
| F-07 | Activities | Tours, spots, meals; RSVP per member; capacity; opening hours; cost per head | P0 |
| F-08 | Tasks / checklists | Shared and private tasks; assignee; due date; reminders; template checklists (pre-trip, packing, departure day) | P0 |
| F-09 | Budget and expenses | Planned vs actual by category; multi-currency with a manually entered rate on the expense date (FX entry hidden until a trip needs it); split equally/by share/by item; balances and settle-up suggestions; expenses count once added, with no approval step | P0 |
| F-10 | Documents | Upload tickets, vouchers, IDs; link to items; per-file visibility; offline copy | P0 |
| F-11 | Notes and links | Rich notes; external links (e.g. vendor social pages) with preview | P0 |
| F-12 | Library | Reusable people, places, vendors, templates; search and dedupe | P0 |
| F-13 | Notifications | In-app and push (PWA) notifications, no email, for invites, changes to items I'm on, due tasks, payments owed; digest option | P1 |
| F-14 | Map view | Items and places on a map; route between day stops | P1 |
| F-15 | Import | Parse booking confirmation emails/PDFs into draft items for review | P1 |
| F-16 | Calendar | iCal feed per user (own perspective) and per trip | P1 |
| F-17 | Polls and decisions | Vote on options (dates, activities, rooms); record the decision | P1 |
| F-18 | Comments | Threaded comments on any item with @mentions | P1 |
| F-19 | Weather and advisories | Forecast per day/place; travel advisories and typhoon alerts | P2 |
| F-20 | Export / share | PDF itinerary, CSV expenses, read-only public link with expiry | P1 |

## Personal and shared perspectives

Every user sees one merged view: the group's shared items plus their own private items, filtered to what concerns them.

- **Visibility per item:** `shared` (all trip members, subject to role), `private` (owner only), or `selected` (owner + named members). Default for new items: shared for organizers, private for members' own tasks/notes.
- **"My trip" view:** only items I'm assigned to, attending, or own — my flights, my room, my vehicle, my tasks, what I owe and am owed.
- **Group view:** the full shared itinerary, room and vehicle allocation, group budget.
- **Personal overlays on shared items:** a member can add a private note, reminder or checklist to a shared item without changing it for others.
- **Promote / demote:** a private item can be shared (audited); a shared item can be made private only by its owner or an organizer.
- **Privacy guarantee:** private items never appear in other users' API/MCP results, exports, notifications or search — including for admins, unless an audited break-glass access is used.
- **Personal library:** each user keeps their own reusable packing list, documents and preferences across trips.

## Access surfaces

Web, API and MCP are thin adapters over one core service layer, so permission, visibility and audit rules are written once and no surface can bypass them.

&#91;embedded content: architecture · 3 surfaces, 1 core, 3 stores\]

| Surface | Audience | Auth | Shape | Key capabilities |
| --- | --- | --- | --- | --- |
| Web app | Travelers, organizers, admins | Self-created platform account via invite link, password; MFA for owners/admins | Responsive SPA + PWA | Dashboard, My trip / Group views, itinerary, history panel, admin console |
| REST API | Mobile apps, scripts, integrations | Web session, or personal access tokens scoped read or write; no OAuth client credentials in MVP | `/v1` resources, OpenAPI 3.1, JSON | Pagination and filters, ETag / If-Match, idempotency keys, `/history` per entity, webhooks (later) |
| MCP server | AI assistants (Claude and others) | OAuth 2.1 per user (auth code + PKCE, Client ID Metadata Documents, allowlisted clients); read and write scopes; destructive tools need human approval | Tools over Streamable HTTP | Tools: `list_trips`, `get_itinerary`, `get_item`, `my_tasks`, `search_library`, `add_item`, `record_expense`, `propose_change`, `get_approval`. Resources and prompts are added only if a client uses them |

- **Parity:** every MCP tool and web action maps to a documented API operation; the API is the contract.
- **Perspective-aware:** API and MCP results are filtered to the calling user's view; private items of others never leak into AI context.
- **AI attribution:** every MCP call is audited with the AI client name and any session or correlation id the client sends, shown as "via AI" in item history.
- **Token-efficient MCP output:** compact summaries by default, detail on request, stable ids so the AI can follow up.

## Admin and auditing

Every create, update, delete, restore, share and permission change writes an immutable audit event in the same transaction as the change.

**Audit event fields**

| Field | Example |
| --- | --- |
| event\_id, timestamp (UTC + actor's TZ) | `evt_…`, 2026-10-16T00:42+08:00 |
| actor (user id) | the signed-in user (service accounts deferred) |
| surface + client | `web` / `api` (personal token id) / `mcp` (AI client name, session or correlation id) |
| action | create, update, delete, restore, share, role\_change, approve, reject, purge, login, export, break\_glass |
| entity type, entity id, trip id | `lodging`, `itm_…`, `trp_…` |
| field-level diff | before / after per changed field, computed from version snapshots at read time (sensitive fields masked) |
| version before / after | 7 → 8 |
| reason (optional, required for admin overrides) | "Fixed wrong check-in date" |
| request id, IP, user agent | for tracing |

**Audit requirements**

- Append-only store; no update or delete API, including for admins. Tamper evidence via hash chaining per trip, verified on demand from the admin console.
- Per-item history panel in the web app: timeline of changes with diff and one-click restore to any version.
- Soft delete everywhere; restore is itself audited. Hard purge only through retention/erasure jobs, which log a tombstone.
- Audit visibility follows data visibility: members see history of shared items; private item history is visible only to its owner; admins see metadata only (time, actor, action, entity type) unless they use break-glass.
- Filters by trip, user, surface, entity, date range; export to CSV/JSON.
- Retention: configurable, default 2 years after trip archive.

**Admin console**

- Maintain accounts (edit, disable, reset MFA) and generate one-time password-reset links to share directly, so the platform sends no email; manage platform roles; set the document retention period (default 30 days, one setting for all trips); review pending AI approvals.
- Curate the shared library: merge duplicate places/vendors, edit reference data, publish templates.
- Manage the MCP client allowlist (by Client ID Metadata Document URL) and rate limits; users list and revoke their own personal access tokens.
- Moderation and support: break-glass access with a mandatory reason and a fresh password or TOTP; no "view as" mode.
- System health: last purge run, failed purges, pending approvals, storage used, process stats; on-demand audit chain verification.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Security | Local platform accounts only, no external identity providers; passwords hashed (Argon2id); lockout after repeated failures; invite and reset links are signed, expiring and revocable; OAuth 2.1 for MCP, personal access tokens for scripts; MFA for admins and owners; RBAC + row-level checks enforced in the service layer, not per surface; AES-256-GCM encryption with one app key for IDs, passport and payment data and uploaded files; secrets as Docker secrets |
| Privacy | Data Privacy Act of 2012 (RA 10173) compliance; consent for storing others' personal data; data export and erasure per user; sensitive uploads purged 30 days after trip end by default; data minimisation (store card last-4 only, never full numbers) |
| Concurrency | Optimistic locking via version/ETag; conflicting writes rejected with the current version for merge |
| Offline | PWA caches the active trip (itinerary, documents, contacts) for read from MVP slice 1a, before the trip; queued edits sync with conflict prompts in release 3 — island destinations have patchy signal |
| Performance | p95 < 300 ms for reads, < 500 ms for writes; trip dashboard < 2 s on 4G |
| Availability | Self-hosted single instance (container deployment), no uptime SLA, publicly reachable for Claude's MCP connector and island use; nightly database dump and upload copy to a disk the admin owns, 7 kept, so up to a day of edits can be lost; manual restore check quarterly |
| Time and money | Store UTC + IANA timezone per event; display in local trip time; integer minor units + ISO 4217 currency; FX rate captured at expense date |
| Accessibility | WCAG 2.2 AA; mobile-first layouts |
| Localisation | English first; i18n-ready strings; date/number formats per locale |
| Observability | Structured JSON logs with a request id linked to audit events; admin health page; no tracing or metrics server |
| Rate limits | Login lockout per username and a per-IP login limit; one write limit per user or MCP client |

## Additional requirements

Added after review and now in scope; priorities use the same P0–P2 scale as Functional requirements.

1. **AI write policy (P0).** MCP reads and non-destructive writes apply directly, are labelled "via AI" in history and are reversible by restore. Destructive actions (delete item or trip, remove member, change roles, purge files) create a pending approval that a human with the right role confirms in the web app; unconfirmed requests expire after 7 days.
2. **Consent for other people's data (P1).** Organizers can enter companions' details; each person can claim their profile and then controls it.
3. **Placeholder travelers (P0).** Travelers without accounts (kids, older relatives) exist as placeholders that can be claimed later.
4. **Payments and debts, record only (P0).** Track deposits, balances due to vendors and member-to-member debts; settle-up marks a debt paid with an optional reference. No GCash/Maya or other payment integration.
5. **Booking rule awareness (P0).** Flag non-refundable/non-changeable fares, deposit deadlines, cancellation windows and missing add-ons such as checked baggage.
6. **Capacity checks (P0).** Validate room and vehicle assignments against capacity (e.g. 5 per e-bike incl. driver) and requirements (a licensed driver per vehicle).
7. **Targeted change notifications (P1).** Notify only people affected by a change (my flight moved), not the whole group.
8. **Versioned API and MCP schemas (P0).** URL versioning (/v1) with additive changes only, generated changelog, and a deprecation policy once a second API consumer exists; MCP tool schemas versioned with the API.
9. **Idempotency and webhooks.** Idempotency keys honoured on POST when sent, always sent by the web app and MCP server (P0); webhooks for item changes so integrations don't poll (P2).
10. **Single tenant (P0).** One instance serves one group of users; users own trips and their personal library; the platform admin is the instance owner. No org layer.
11. **Document retention (P0).** Sensitive uploads (IDs, tickets, vouchers) are purged 30 days after the trip end date by default; the admin changes this in one setting that applies to all trips. Each purge writes an audit tombstone.
12. **Search (P1).** Global search across trips, library and documents, respecting visibility.
13. **Trip post-mortem (P2).** Actual vs planned spend, ratings for vendors and places, notes that feed the library for the next trip.

## Reference case: Siquijor, Nov 2026

The MVP is done when the Siquijor trip can be run end to end on the platform, and a second trip can be cloned from it. Slice 1a must run the trip on web and REST before 11 Nov; slice 1b completes the MVP after the trip.

| Trip aspect | How it maps |
| --- | --- |
| PAL Manila → Dumaguete, 11 Nov, and return 14 Nov | Two Transport items; fare flagged non-refundable/non-changeable; baggage add-on as an open task |
| Dumaguete → Siquijor crossing | Transport items (ferry) linked to the flight arrival; gap detection warns if missing |
| Lagwerta Guest House, 5 couple rooms | Lodging item with 5 rooms × 2; occupant assignment for 10 members; vendor saved to Library |
| 2 e-bikes, 5 seats each incl. driver | Ground transport items; capacity check; driver assignment from members |
| Paliton Beach and other spots | Places in Library; Activities on day plans with RSVP |
| 10 travelers | Memberships; placeholder travelers for anyone without an account |
| Shared costs | Budget categories (airfare, lodging, e-bikes, food, fees); splits and settle-up |

**Release phases**

1. MVP in two slices. **1a, before 11 Nov:** auth and invites, roles and visibility, trips and items, room and e-bike capacity, itinerary with warnings, expenses and settle-up, audit log, REST API, web app with offline read. **1b, after the trip:** MCP (read + write; destructive actions need approval), history panel and restore, clone and templates, retention purge.
2. Release 2: notifications, calendar feeds, map, import from confirmation emails, comments, polls, exports.
3. Release 3: offline sync for edits, weather/advisories, webhooks.

**Decisions**

| Topic | Decision |
| --- | --- |
| Hosting | Self-hosted for personal use; single tenant. A home machine with a public IP, otherwise the smallest VPS, plus a domain; it must be publicly reachable for Claude's MCP connector and for use on the island |
| MCP writes | Apply directly; only destructive actions need human approval |
| Accounts | Platform accounts only (password + MFA). No Google, Apple or magic-link sign-in, which avoids a paid Apple Developer Program membership (US$99/year) and an outbound email provider. Users create their own account (credentials) from a shareable trip invite link; no open sign-up. Admins manage accounts and generate password-reset links they share directly, so the platform sends no email |
| Settle-up | Record only; no GCash/Maya integration |
| Document retention | IDs, tickets and vouchers purged 30 days after trip end; one admin setting for all trips |
| Expenses | No approval step; expenses count once added, and owners and organizers can edit or void any expense (audited) |
| Backups | Nightly dumps to a disk the admin owns, 7 kept; no point-in-time restore, so up to a day of edits can be lost |
| Audit tamper evidence | Hash chain per trip kept, verified on demand from the admin console; no nightly job or off-box anchor |
| API auth | OAuth serves MCP only; REST takes the web session or personal access tokens. Service accounts, client credentials and on\_behalf\_of are deferred |
| Admin support access | Break-glass with a reason; admins see only metadata in private-item history; no "view as" mode |
| MCP surface | Tools only in MVP; resources and prompts are added if a client uses them |
| MVP timing | Slice 1a ships before the 11 Nov trip; slice 1b (MCP, restore UI, clone, retention purge) follows |
