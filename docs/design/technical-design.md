# Tribo — Technical Design

Oct 16, 2026 · @Eris Sales · Source: Tribo PRD (Oct 16, 2026)

## Summary and scope

Tribo ships as one TypeScript modular monolith on PostgreSQL, deployed as a single Docker Compose stack. Web, REST and MCP are adapters over one operation registry, so permission, visibility and audit rules exist once. This design covers release 1 (MVP) in depth and sketches releases 2 and 3.

**Design principles**

- **The API is the contract.** Each operation is declared once: input/output schema, required scopes, destructive flag, handler. REST routes, MCP tools and the web client are generated from or bound to that registry.
- **One transaction per write.** Authorize → validate → version check → mutate → version snapshot → audit event, committed together or not at all.
- **Private by construction.** One visibility predicate lives in the repository layer and every query goes through it; property-based leak tests guard it.
- **One process, one database.** A single Node.js process serves web, API, MCP and auth and runs daily jobs; Postgres holds data, search and audit; uploads sit on a local volume. No Redis, job queue, tracing stack, external identity provider or outbound email.

## Architecture

Tribo runs as one Node.js process beside PostgreSQL, behind Caddy, which terminates TLS with Let's Encrypt. Uploads live on a local volume, sensitive data is encrypted with one app key from a secret file, and nightly backups go to a disk you own.

&#91;embedded content: component view · 3 surfaces, 1 core, 1 process\]

The browser talks to the same REST API as any app; only AI assistants use the MCP endpoint, and every path ends in the core.

- **Web parity is structural.** The SPA is a first-party REST client (cookie session + CSRF token), so any web action is by definition an API operation.
- **MCP is in-process.** The MCP server is mounted at `/mcp` in the app process and invokes registry operations directly, not over HTTP.
- **Auth server is in-process.** It handles login, MFA and the OAuth 2.1 authorization server; the MCP endpoint validates its OAuth tokens, while REST accepts the web session or a personal access token.
- **Daily jobs are in-process.** A timer guarded by a Postgres advisory lock runs the retention purge; approval expiry is checked on read, so no queue or worker is needed.
- **Modules, not services.** Identity, trips & membership, items, itinerary, expenses, documents, library, audit and notifications each own their tables and expose service interfaces; no module reads another's tables.
- **Hosting.** Any Linux host that runs Docker Compose, reached through one of the deployment modes below. Members use the web app from the island and Claude reaches MCP from Anthropic's cloud, so both need a publicly reachable HTTPS origin on a domain the operator owns.

| Compose service | Image | Notes |
| --- | --- | --- |
| `proxy` | Caddy | TLS per deployment mode (Let's Encrypt, Cloudflare Origin CA or internal CA), client IP from trusted proxies only, static SPA assets, HTTP/2 |
| `app` | tribo | REST, MCP, auth, daily jobs; uploads on a local volume; app key as a Docker secret |
| `db` | PostgreSQL 18 (current major) | Nightly pg\_dump to a disk you own, 7 kept |
| tunnel | cloudflared | Optional Compose profile, Cloudflare Tunnel mode only; no inbound ports |

**Deployment modes** (decided 17 Oct 2026)

The mode is configuration, not code: the Compose `.env` sets the public URL, the TLS mode (`acme-http`, `acme-dns-cloudflare`, `origin-cert`, `internal`) and the trusted proxy ranges. The proxy image is built with Caddy's Cloudflare DNS module so one image serves every mode.

| Mode | Fits | TLS and edge | Limits | MCP |
| --- | --- | --- | --- | --- |
| Public host | VPS, or home machine with a public IP; any DNS provider | Caddy, Let's Encrypt HTTP-01 | None beyond Tribo's own | Available |
| Cloudflare, DNS only | Domain on Cloudflare, record not proxied | Caddy, Let's Encrypt HTTP-01 or DNS-01 with a scoped API token | None | Available |
| Cloudflare, proxied | Origin hiding and DDoS absorption wanted | Cloudflare terminates TLS (SSL mode Full strict); Caddy holds an Origin CA or DNS-01 certificate; origin firewall admits only Cloudflare ranges | 100 MB request bodies on Free and Pro; proxy read timeout (125 s default, fixed below Enterprise); Cloudflare sees decrypted traffic | Available; WAF and Bot Fight Mode must skip `/mcp`, `/.well-known/*` and OAuth paths |
| Cloudflare Tunnel | Host behind carrier-grade NAT or with no open ports | `cloudflared` service; no inbound ports | As proxied | Available |
| Private | LAN or VPN only, testing | Caddy internal CA | Unreachable from the island and from Claude | Off |

- **Reference deployment:** the owner's instance runs on a VPS with its domain on Cloudflare, DNS only. Nothing in the app assumes it.
- **MCP is opt-in** and only offered in publicly reachable modes; it is switched by TRIBO\_MCP\_ENABLED, a deploy setting kept with the mode rather than in the database; start-up refuses it in Private mode and the admin health page shows it read-only.
- **Derived from config, never from the Host header:** the OAuth issuer, the MCP resource indicator, CIMD fetches and invite links all use the configured public URL.
- **Client IP:** Caddy accepts forwarded addresses only from the configured trusted ranges (Cloudflare's in proxied and tunnel modes, via `CF-Connecting-IP`), so login lockout and per-IP limits see the real client.
- **Proxied and tunnel modes:** the setup screen discloses that Cloudflare decrypts traffic, the upload ceiling stays at 25 MB (below the 100 MB edge limit), MCP responses send `Cache-Control: no-store` and `X-Accel-Buffering: no`, and any open stream sends a keep-alive comment every 15 s.

## Tech stack

TypeScript end to end, with one schema source (Zod) generating validation, OpenAPI 3.1 and MCP tool input schemas.

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js (current LTS), TypeScript strict | One language for core, SPA and MCP SDK |
| HTTP | Fastify | Schema-first routes, low overhead, mature plugin set |
| Schemas | Zod → JSON Schema | Same definition drives REST validation, OpenAPI and MCP `inputSchema` |
| Database | PostgreSQL 18+ (built-in uuidv7()) + `pg_trgm`, `citext` | Triggers, JSONB, full-text and trigram search in one store |
| Data access | Kysely + plain SQL migrations | Typed queries without hiding triggers and partial indexes |
| Daily jobs | In-process timer + Postgres advisory lock | One scheduled job (retention purge) needs no queue library |
| Passwords / MFA | Argon2id (`@node-rs/argon2`), TOTP + recovery codes | PRD security row |
| OAuth 2.1 AS | `node-oidc-provider`, configured for OAuth only | PKCE, resource indicators and refresh built in; confirm CIMD support in the chosen version, else add a client lookup that fetches and validates the metadata document |
| MCP | Official MCP TypeScript SDK, Streamable HTTP | Targets spec revision 2026-07-28 |
| Web | React + Vite, TanStack Router/Query, Workbox, Dexie (IndexedDB) | SPA + PWA with offline cache |
| Uploads | Local volume | No object store to run |
| Crypto | Node `crypto` AES-256-GCM, one app key | No native deps, no key hierarchy |
| Logging | pino JSON logs with field redaction | Request id on every log line and audit event; no tracing or metrics server |
| Tests | Vitest, Testcontainers (Postgres), Playwright | Real database in tests; triggers exercised |

## Data model

Items live in one `items` table with typed JSONB `details`, plus relational child tables wherever a rule needs integrity (rooms, tickets, allocations, shares). Visibility, versioning, audit and the itinerary all work on the common columns, so one table keeps those paths single. The full DDL is claude/db/0001\_init.sql in the project, tested on PostgreSQL 18.4 with the Siquijor data.

**Conventions**

- **Ids:** TypeID (prefix + UUIDv7 from Postgres's built-in uuidv7()) stored as `uuid`, rendered with prefix at the API edge (`trp_…`, `itm_…`, `evt_…`). Sortable, stable for AI follow-ups.
- **Root rows:** `version int`, `created_at/by`, `updated_at/by`, `deleted_at/by`. Partial unique indexes ignore soft-deleted rows. Owned rows (allocations, item and expense shares, trip destinations, budget lines) have no version or soft delete: they are replaced with their root and captured in its snapshot. Credentials are revoked or expire; logs are append-only.
- **Time:** `timestamptz` plus an IANA `tz` per start and end; all-day items use `date`. Display converts to the item's own zone, falling back to the trip zone.
- **Money:** `amount_minor bigint` + `currency char(3)`; expenses also store `fx_rate numeric(18,8)`, `fx_date`, `fx_source`.
- **Sensitive values:** separate `bytea` ciphertext columns (`passport_enc`, `booking_ref_enc`), never inside JSONB, so masking and purge are column-precise. Each value is key version ‖ nonce ‖ ciphertext ‖ tag, with AAD = table.column:row id, so a ciphertext copied to another row will not decrypt.

**One rule.** Every fact has exactly one owner, and only that owner stores, changes, versions and enforces it (schema review, `claude/design/schema-review-2026-10-17.md`, R37–R41). Rows are roots, owned rows, credentials or logs. The database declares what one row can express; the service's write path enforces anything that needs other rows, the caller or the clock. Inside a trip a person is their membership; outside it, their account. Derived state (archived, expired, sensitive, freshness) is computed, never stored.

**Tables (MVP)**

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | `username citext`, `password_hash`, `mfa_secret_enc`, `platform_role`, `status`, `locked_until` | Local accounts only; an active admin must have MFA |
| `persons` | `user_id` (null = placeholder, forever), `merged_into`, contacts, dietary, `emergency_contact_enc`, `driving_licence`, `id_doc_enc`, `passport_enc`, `consent_recorded_at`, `erased_at` | Claims are per trip: accepting moves only that trip's placeholder membership to the claimer's own person. A placeholder never gains an account; with no memberships left it is scrubbed and points to the survivor via `merged_into`. Erasure scrubs personal fields and keeps the row. ID and passport ship in 1b and need recorded consent (CHECK) |
| `places`, `vendors` | name, kind, `lat`/`lng`, hours, links, `merged_into` | One shared library (single tenant); admin merge (1b) soft-deletes the duplicate and sets `merged_into` so old ids resolve |
| `templates` | `owner_id` (null = shared), `kind` (trip, packing, checklist, budget), `body jsonb` | Personal packing lists and shared templates (1b) |
| `trips`, `trip_destinations` | dates, `currency`, `timezone`, `status`, `archived_at`, `audit_retired_at`, `budget_version`, `cloned_from` | Owner = the membership with role owner; status transitions enforced in service. Archived ⇔ `archived_at` (from completed, one-way, read-only after); a retired audit chain freezes the trip |
| `memberships` | `trip_id`, `person_id`, `trip_role`, `can_view_costs` | Unique per trip + person, one owner per trip; no status column (join is by link only; removal = soft delete) |
| `invites` | `trip_id`, `token_hash`, `role`, `person_id`, `expires_at`, `max_uses`, `uses`, `revoked_at` | Link is `/join#<token>`; token shown once, stored hashed. A pre-linked placeholder must be a member of the same trip (FK), and that invite is single use |
| `items` | `trip_id`, `type`, `title`, `start_at`/`start_tz`, `end_at`/`end_tz`, `place_id`, `vendor_id`, `status`, cost, `visibility`, `owner_membership_id`, `tags`, `details jsonb`, `booking_ref_enc`, `board_version` | Cost is the booked price; who paid is an expense linked by `item_id`. `version` covers item fields, `board_version` the assignment board and RSVPs |
| `item_shares` | `item_id`, `membership_id` | Owned rows: memberships that can see a `selected` item |
| `units` | `item_id`, `kind` (room, vehicle), `label`, `capacity`, `bed_type`, `rate_minor` | Rooms of a lodging; e-bikes of a rental |
| `allocations` | `item_id`, `unit_id`, `membership_id`, `role` (attendee, occupant, driver, passenger, assignee), `rsvp` | The item's assignment board, replaced whole on each save under `board_version`; no per-row version (history is in the `item_board` snapshot) |
| `tickets` | `item_id`, `membership_id`, `seat`, `ticket_no_enc`, `baggage` | Per-passenger transport, edited apart from the board |
| `checklist_entries` | `item_id`, `position`, `text`, `done_by`, `done_at` | Task and template checklists (1b) |
| `overlays` | `item_id`, `membership_id`, `note`, `reminder_at`, `checklist jsonb` | Always private to its membership |
| `expenses` | `trip_id`, `item_id`, `category`, `payer_membership_id`, amount, FX, `trip_amount_minor`, `split_method` | Voiding = soft delete, audited |
| `expense_shares` | `expense_id`, `membership_id`, `share_minor`, `weight` | Owned rows, one per member included; frozen at write time and summing to `trip_amount_minor` |
| `budget_lines` | `trip_id`, `category`, `planned_minor` | Planned side of budget vs actual (1b); owned rows replaced whole under `trips.budget_version` |
| `files` | `trip_id`, `item_id`, `owner_membership_id`, `kind`, `sensitive` (generated from kind), `visibility` (shared, private), `blob_key`, `sha256`, `enc_key_version`, `purged_at` | Purge date computed, never stored (see Documents) |
| `entity_versions` | `entity_type`, `entity_id`, `version`, `trip_id`, `snapshot jsonb` | Source for restore and history diffs, one series per aggregate (`item`, `item_board`, `trip_budget`, …) at its counter; ciphertext stays ciphertext |
| `audit_events`, `approvals`, `idempotency_keys`, sessions, personal access tokens, OAuth store, `mcp_clients`, `platform_settings` | — | Covered in later sections |

**Item `details` by type** (Zod schema per type, versioned with the API)

| Type | Details |
| --- | --- |
| `transport` | mode (flight, ferry, bus, van), carrier, number, from/to place, refundable, changeable, baggage included, add-ons, linked item ids |
| `lodging` | check-in/out times, deposit amount + due date, balance due date, cancellation window |
| `ground` | kind (e-bike, scooter, van), seats per unit incl. driver, licence required, pickup/return place + time, fuel/charge notes |
| `activity`, `meal` | capacity, cost per head, RSVP deadline |
| `task` | due, reminder, parent item |
| `note` | rich-text body (ProseMirror JSON), links with cached preview |
| `document` | file ids |

## Authorization and visibility

Each operation is checked by one policy function, `can(actor, action, resource)`, and every read is narrowed by one SQL visibility predicate in the repository layer; property-based leak tests guard both.

**Effective permission** = platform role ∩ trip role ∩ token scopes. The stricter rule always wins. Platform admins get no implicit trip membership: their trip data access is break-glass only.

| Action | Owner | Organizer | Member | Viewer |
| --- | --- | --- | --- | --- |
| Read shared items | Yes | Yes | Yes | Yes, masked |
| Read individual costs | Yes | Yes | Yes | Only if `can_view_costs` |
| Create/edit shared items | Yes | Yes | Create own; edit own or assigned | No |
| Answer own RSVP | Yes | Yes | Yes | No |
| Reveal sensitive fields | Yes | Yes | Own items, own ticket, own person record | No |
| Manage tickets | Yes | Yes | On items they own; seat and baggage on their own ticket | No |
| Transfer ownership | Yes, to a member with MFA | No | No | No |
| Leave the trip | No (transfer first) | Yes | Yes | Yes |
| Own private items, overlays | Yes | Yes | Yes | No |
| Add expense | Yes | Yes | Yes | No |
| Edit or void any expense, assign tasks | Yes | Yes | Own expenses only | No |
| Invite/remove members, set roles | Yes | No | No | No |
| Archive, clone, delete trip | Yes | No | No | No |
| Make a shared item private | Item owner or organizer | Yes | Own items only | No |

**Visibility predicate** (composed into every item, file, overlay and audit query):

```sql
-- :mid = the caller's active membership in the item's trip (null if none or the trip is deleted)
item.deleted_at IS NULL
AND :mid IS NOT NULL
AND ( item.visibility = 'shared'
   OR item.owner_membership_id = :mid
   OR (item.visibility = 'selected' AND EXISTS (SELECT 1 FROM item_shares s WHERE s.item_id = item.id AND s.membership_id = :mid)) )
```

- **One predicate, one place.** Item, file, overlay, version and audit queries all call the same repository function; no query builds its own visibility filter.
- **Field masking.** Fields carry a class (`sensitive`, `cost`). One serializer masks them per caller for REST, MCP, exports, notifications and history diffs alike; items can add `restricted_fields` to tighten further.
- **Break-glass (1b).** An admin steps up with a fresh password or TOTP, stamped on the session, then sends a `Break-Glass-Reason` header on history and audit reads within 10 minutes. Every read under it logs a `break_glass` event, visible in the affected owner's history. No grant table.
- **Admins and private history.** Admins see metadata only (time, actor, action, entity type) for private items; titles and diffs need break-glass.
- **Leak testing.** Property-based tests generate random trips, roles and visibilities, then assert no private row reaches another user through REST, MCP, search, export or notification payloads.

**Beyond items** (decided 17 Oct 2026)

- **Children follow their item.** Files, tickets, allocations, overlays, checklist entries, versions and audit rows of an item are visible only when `tribo.item_visible(uid, item_id)` holds, so a shared file on a private item stays private.
- **The ledger stays whole.** Expenses are visible to every member (costs masked for viewers without `can_view_costs`), even when linked to a private item; the serializer nulls `itemId` for callers who cannot see that item.
- **People are not a public library.** A person row is visible to the person, its creator while it is still a placeholder, and anyone sharing an active trip with it (`tribo.person_visible`); library people search returns only those rows. Sensitive person fields go only to the person and the owners and organizers of a shared trip.
- **Reveal.** Sensitive fields are masked by default for everyone, the item owner included. `POST /v1/{entity}/{id}/reveal {fields}` returns the plaintext to callers allowed to see it and writes a `reveal` audit event naming the field paths, never the values. Revealed values are never cached offline. In 1a it covers booking refs, ticket numbers, card last-4 and emergency contacts; ID and passport join in 1b. Through MCP (1b) a reveal goes to approval.
- **Shared library edits.** Any signed-in user creates and edits places and vendors, audited on the platform chain. There is no delete in MVP; admins merge duplicates in 1b.

## Identity and auth

Accounts exist only through invite links or the admin. One in-process OAuth 2.1 authorization server issues MCP tokens; the web app uses sessions and scripts use personal access tokens. No flow sends email.

**Accounts and links**

- **Bootstrap:** `tribo admin create` (CLI in the app container) makes the first platform admin.
- **Invite link:** `/join#<token>`, a 256-bit random token stored as SHA-256, with role, expiry, max uses and `revoked_at`. New users choose a username + password there; existing users sign in and join. The owner can pre-link the invite to a placeholder member of the same trip; accepting moves only that trip's membership to the joiner's own person, so a claim never reaches another trip.
- **Reset link:** admin-generated, single use, 24-hour expiry, shown once to copy. Using it sets a new password and revokes all sessions and refresh tokens.
- **Username + password are the primary credentials.** Usernames are unique and case-insensitive (3–32 characters: letters, digits, dot, dash, underscore); TOTP is added where MFA applies. Accounts hold no email address, and recovery is always admin-mediated.
- **Password change:** a signed-in user changes their own password by entering the current one; their other sessions are revoked.

**Credentials**

- Argon2id at OWASP minimums or above (19 MiB memory, 2 iterations, parallelism 1), tuned to about 250 ms on the host.
- Lockout in the app: 5 failures → 15-minute lock per username, plus a per-IP login limit (Operations).
- MFA: TOTP + 10 recovery codes, required for platform admins and before a user can own a trip. Admin can reset MFA (audited). Passkeys are a P1 add: they need no Apple developer membership.
- Step-up: only break-glass asks for a fresh password or TOTP; other sensitive actions rely on the MFA-protected session.

**Web sessions:** server-side session rows; `__Host-` cookie, HttpOnly, Secure, SameSite=Lax; CSRF header required on unsafe methods; 7-day idle and 30-day absolute expiry.

**OAuth 2.1 for MCP, tokens for scripts**

- OAuth exists for MCP; scripts and apps use personal access tokens. Grants: authorization code + PKCE (S256 only) and refresh tokens. No client credentials or service accounts in MVP.
- Access tokens are bound to `https://<host>/mcp` with resource indicators (RFC 8707). They are opaque, stored hashed, live 10 minutes, and are rejected outside that audience.
- MCP discovery per spec 2026-07-28: Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, AS metadata (RFC 8414), `iss` in authorization responses (RFC 9207), 401 challenges carrying `resource_metadata` and `scope`.
- MCP client registration: Client ID Metadata Documents only. AS metadata advertises `client_id_metadata_document_supported: true` and the `none` token auth method, which Claude needs to choose CIMD; the client's `client_id` URL must be on the admin's allowlist. No pre-registration or Dynamic Client Registration.
- Consent screen names the client and the scopes.
- Personal access tokens (`tribo_pat_…`): `read` or `write`, expiring (≤ 1 year), hashed, listed and revocable by their owner.
- Consent and connections (1b): the SPA consent page drives `oauth.interaction.*`; users list and revoke their own MCP grants; admins can disable an allowlisted client without removing it.

| Scope | Grants |
| --- | --- |
| `read` | Everything the user can see, filtered to their view |
| `write` | Everything the user can change; destructive MCP calls still go to approval |

Admin operations are web-only (session + MFA) and are never granted to tokens. File purge (irreversible) and AI approval decisions are session-only too, so a leaked token cannot destroy data and an AI cannot approve its own request.

Sources: [MCP authorization spec 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx), [WorkOS summary of the 2026-07-28 changes](https://workos.com/blog/what-is-mcp-authorization), [Claude connector authentication](https://claude.com/docs/connectors/building/authentication).

## Audit and versioning

Each write stores one full snapshot in `entity_versions` and one metadata-only audit event, in the same transaction as the change. History diffs are computed from consecutive snapshots and masked when they are read, so change data is stored once.

**Write path (every mutating operation)**

1. Authorize, validate input, load the row `FOR UPDATE`.
2. Compare the caller's `If-Match` version; mismatch → `412` with the current representation.
3. Apply the change, bump `version`, insert the `entity_versions` snapshot.
4. Insert the audit event; its insert trigger takes a per-chain advisory lock, reads the previous hash and computes the new one.
5. Commit.

**`audit.audit_events` columns:** `id`, `chain_key`, `seq`, `hash_version`, `occurred_at` (UTC) + `actor_tz`, `actor_user_id`, `surface`, `client_id`, `client_name`, `mcp_session`, `action`, `entity_type`, `entity_id`, `trip_id`, `version_before`, `version_after`, `restored_from`, `reason`, `request_id`, `prev_hash`, `hash`. No field values, IP addresses or user agents are stored in audit rows: IP and user agent live in the JSON logs, joined by `request_id` (PRD change, decided 16 Oct 2026).

- **Append-only.** Separate `audit` schema; `tribo_app` has `INSERT` and `SELECT` only, a trigger rejects `UPDATE`/`DELETE`, and `TRUNCATE` is revoked. No API route mutates audit rows.
- **Hash chain.** One chain per trip, one auth chain per UTC month (sign-ins and credential events) and a `platform` chain. The insert trigger sets `hash = SHA-256(prev_hash ‖ canonical JSON of the row)`; no head table or app-side chaining code.
- **Verification on demand.** The admin console recomputes a chosen chain (or all) and reports the first broken link. No nightly job and no off-box anchor: the instance owner is the only party who could tamper.
- **Diffs.** Computed at read time from `entity_versions` (version n−1 vs n); `sensitive` fields show only "changed". The UI resolves user ids to names at read time.
- **Restore.** `POST /v1/{entity}/{id}/restore {version}` copies a snapshot forward as version n+1 and logs `restore` with `restored_from`. Undelete is the same call. It requires If-Match, and restoring a parent also undeletes the children removed in the same request. References to purged files come back as "purged" placeholders.
- **Soft delete everywhere.** Children soft-delete with their parent. Hard deletion happens only in retention and erasure jobs, which remove rows and snapshots and log a content-free `purge` tombstone.
- **Erasure (RA 10173).** Scrub the person's personal fields and delete every snapshot that contains them. The person row and its memberships stay as a tombstone, so other members' expenses and shares still add up. Audit rows hold only ids and metadata, so the append-only log never needs editing. An admin runs it from a web session (admin.people.erase, 1b).
- **Retention.** A trip's chain is dropped whole audit\_retention\_days (default 730) after the trip is archived or deleted, once its due files are purged, by the daily job through a SECURITY DEFINER function owned by the migration role (the app role never holds DELETE on audit rows); the function records the final head hash in the `platform` chain.
- **Who sees what.** Audit reads go through the visibility predicate of the target entity: members see shared-item history; private-item history is owner-only; admins see metadata only unless they use break-glass.
- **Querying.** Indexes on (`trip_id`, `occurred_at`), (`actor_user_id`, `occurred_at`), (`entity_id`, `seq`). A request\_id index lets restore find the children removed by the same request. CSV/JSON export streams results and is itself audited as `export`.

## API design

The REST API is generated from the operation registry: each operation declares its id, schemas, scopes and destructive flag once, and CI fails if any web route or MCP tool lacks an operation id.

```ts
defineOperation({
  id: 'items.update',
  http: { method: 'PATCH', path: '/v1/items/{itemId}' },
  scopes: ['write'],
  destructive: false,
  input: ItemPatch,          // Zod
  output: Item,
  handler: (ctx, input) => items.update(ctx, input),
});
```

**Resources (v1).** The full list of 130 operations, with roles, write rules, slices and drops, is the operation registry (`packages/contract/src/operations/*.ts`), the one source of the list; the [Operation inventory](https://claude.ai/code/artifact/178b4be3-bdc8-4697-9cc6-f5a013c10d3a) explains its columns and records the gap decisions. The table below is an overview by path.

| Path | Purpose | Slice |
| --- | --- | --- |
| `/v1/auth/*`, `/v1/invites/preview`, `/v1/invites/accept` | Login, session + CSRF token, TOTP setup, step-up, reset link, invite preview and join; secret tokens travel in the body | 1a |
| `/v1/me`, `/v1/me/tasks` | Profile, "My trip" tasks across trips | 1a |
| /v1/me/password | Change own password; other sessions revoked | 1a |
| /v1/me/connections | MCP clients holding a grant; revoke one | 1b |
| `/v1/me/tokens` | Personal access tokens: list, create (shown once), revoke | 1b |
| `/v1/trips`, `/v1/trips/{id}/clone`, `/archive` | Trip lifecycle; archive after the trip, clone in 1b | 1a |
| `/v1/trips/{id}/dashboard`, `/offline-bundle` | One-call dashboard (my share, no balances) and the offline read bundle; both polled with `If-None-Match` on a SHA-256 ETag of the per-caller representation | 1a |
| `/v1/trips/{id}/members`, `/invites` | Membership, roles, placeholders, invite links | 1a |
| `/v1/trips/{id}/items`, `/v1/items/{id}` | All item types; `?type=`, `?from=&to=`, `?assignee=me` | 1a |
| `/v1/items/{id}/overlay` | Caller's private note, reminder, checklist | 1a |
| `/v1/items/{id}/units`, `/v1/units/{id}` | Rooms of a lodging, vehicles of a rental | 1a |
| `/v1/items/{id}/assignments` | Whole board of RSVPs, occupants, drivers, passengers and assignees, saved in one `PUT` with `If-Match` on `boardVersion` | 1a |
| /v1/items/{id}/rsvp | The caller's own RSVP; item lock and `boardVersion` bump, no If-Match | 1a |
| /v1/{entity}/{id}/reveal | Plaintext of masked sensitive fields for allowed callers; audited as reveal | 1a |
| `/v1/items/{id}/tickets`, `/checklist` | Per-passenger tickets; shared checklist entries are 1b | 1a |
| `/v1/trips/{id}/itinerary?view=me\|group` | Merged day timeline with warnings | 1a |
| `/v1/trips/{id}/expenses`, `/v1/expenses/{id}` | Expense ledger and each expense's split among the members included (Drop B); record only, no balances, debts or settle-up (R36) | 1a |
| `/v1/trips/{id}/budget` | Planned vs actual by category | 1b |
| `/v1/trips/{id}/files`, `/v1/files/{id}/content`, `/purge` | Upload, download (permission-checked); purge (session only) after the trip | 1a |
| `/v1/library/{people,places,vendors}`, `/v1/library/search` | Search and inline create in 1a; browse and edit pages after the trip; admin merge in 1b | 1a |
| `/v1/library/templates` | Personal and shared templates; apply one to a trip | 1b |
| `/v1/{entity}/{id}/history`, `/restore` | Audit timeline, restore | 1b |
| `/v1/approvals` | Pending AI approvals; decided in a web session only | 1b |
| `/v1/admin/*` | Accounts, reset links, MFA reset, settings, health after the trip (the `tribo admin` CLI covers accounts before it); MCP client allowlist, audit query, export and verify, and erasure are 1b | After trip |
| /healthz, /v1/openapi.json | Public liveness with no details; generated spec for signed-in users | 1a |

**Conventions**

- **Contract workflow:** Zod schemas and registry entries are written first with handlers stubbed; CI generates OpenAPI from them and diffs it against the last approved version. The hand-written draft in the project (`claude/api/openapi.yaml`) was retired on 16 Oct 2026; the Zod schemas are the only source.
- **Schemas:** each resource has three: `<X>Input` (create; strict, nothing nullable that the server fills), `<X>Patch` (all optional) and `<X>` (output; server fields and maskable values). Reusing output schemas for input fails in OpenAPI 3.1, which does not exempt read-only `required` fields: the draft rejected valid creates and accepted `amount: null`.
- **Field names:** camelCase in JSON; snake\_case stays in SQL.
- **Errors:** RFC 9457 `application/problem+json` with `code` from one closed enum shared by REST and MCP: `unauthenticated`, `mfa_required`, `forbidden`, `not_found`, `validation_failed`, `if_match_required`, `version_conflict`, `idempotency_key_reused`, `capacity_exceeded`, `room_double_booked`, `driver_taken`, `invalid_transition`, `masked_field_write`, `rate_limited`, `file_too_large`, `file_type_not_allowed`, `file_purged`, `username_taken`, `invite_invalid`, `already_member`, `claim_conflict`, `person_has_account`, `owner_transfer_required`, `reset_link_used`, `currency_locked`, `trip_archived`, `trip_retired`, `approval_required`, `approval_not_pending`. Only MCP returns `approval_required`, with the pending approval id.
- **Reads:** keyset cursor pagination (`limit` ≤ 200), `?fields=` sparse fields, `?view=summary|full`. Every read carries a SHA-256 ETag of the per-caller representation; polled reads (dashboard, offline bundle) answer `If-None-Match` with `304`.
- **Writes:** `PATCH` takes JSON Merge Patch (RFC 7396). Any write that could overwrite a change it hasn't seen carries `If-Match` naming its aggregate's counter: a root's `version`, an item's `boardVersion` or a trip's `budgetVersion` (`428` without it, `412` with the current body on conflict). Replacing a value only the caller owns (their own RSVP) takes none, and credentials (invites, tokens) carry no counter.
- **Masked fields are read-only:** a write that sets a field masked for the caller is rejected (`409 masked_field_write`), and the SPA sends only changed fields, so a masked `null` never overwrites the real value.
- **Time input:** writes take wall-clock time plus zone (`{"local": "2026-11-11T07:40", "tz": "Asia/Manila"}`) or an all-day date, never both. The server resolves the UTC instant and returns it read-only, so neither the SPA nor an AI computes offsets.
- **Secrets never in URLs:** invite and reset tokens go in request bodies. Invite links are `/join#<token>`, so the token stays in the fragment and never reaches proxy logs; the `/reset/<token>` page posts its token to the API and Caddy logs redact that path. Both pages send `Referrer-Policy: no-referrer`.
- **Idempotency:** only operations that create something take `Idempotency-Key` (key, request hash and response kept 24 hours per caller; same key with a different body → `422`). Other writes are naturally idempotent through If-Match or a one-way transition; auth acts and reveals are never replayed. Shown-once secrets are never stored: a replay omits them and returns `redacted: true`. Drop B honours the header on `expenses.create` and `files.upload`; the other creates follow in 1b.
- **Versioning:** major version in the URL; within `/v1` changes are additive only. CI generates a changelog from the OpenAPI diff on every merge. A deprecation and sunset policy is added once a second API consumer exists.
- **Warnings, not errors:** advisory checks (booking rules, gaps, missing licensed driver) return a `warnings[]` array on reads and writes; only hard invariants (over capacity, a member in two rooms the same night) reject a write.
- **Upserts and multi-row saves:** a personal overlay takes `If-None-Match: *` to create and `If-Match` to replace. The assignment board and the budget are saved whole under `boardVersion` and `budgetVersion`, each bumped on every save.
- **Reveal scope:** reveal operations need write scope; through MCP they always go to approval.
- **Meta endpoints:** public `GET /healthz` returns no details, for Compose and Caddy; `GET /v1/openapi.json` serves the generated spec to signed-in users.

## MCP server

Every MCP tool is a thin wrapper over a registry operation, called as the signed-in user with that user's perspective; reads and non-destructive writes apply at once, destructive ones become pending approvals.

| Tool | Operation(s) | Kind |
| --- | --- | --- |
| `list_trips` | `trips.list` | read |
| `get_itinerary` | `itinerary.get` (view me or group, date range) | read |
| `get_item` | `items.get` (detail summary or full) | read |
| `my_tasks` | `me.tasks` | read |
| `search_library` | `library.search` | read |
| `add_item` | `items.create` | write |
| `update_item` | `items.update` | write |
| `set_rsvp` | `items.rsvp` | write |
| `assign` | `items.assignments.replace` | write |
| `record_expense` | `expenses.create` | write |
| `delete_item` | `items.delete` | approval |
| `reveal_fields` | `*.reveal` | approval |
| `manage_member` | `members.remove`, `members.setRole` | approval |
| `delete_trip` | `trips.delete` | approval |
| `get_approval` | `approvals.get` | read |

One tool per operation replaces `propose_change`, as the PRD review decided, so each tool's input schema is exactly its operation's. `files.purge` and approval decisions are session-only and have no tool.

- **Tools only in 1b.** Resources and prompts repeat what `get_itinerary` returns and are optional for clients; they are added later only if a client uses them (PRD change).
- **Annotations:** `readOnlyHint`, `destructiveHint` and `idempotentHint` come from the registry flags.
- **Token-efficient output:** each result returns a short text summary plus `structuredContent`; default summaries stay under about 1,500 tokens, times are shown in local trip time, and every row carries its stable id and `version` so the AI can follow up or write with `If-Match` semantics.
- **Attribution:** audit rows record `surface = mcp`, the OAuth `client_id`, the client name from its Client ID Metadata Document and any session or correlation id the client sends; history shows these as "via AI".
- **Untrusted content:** notes, vendor pages and imported text returned to the AI are data. No tool executes instructions from item content, and the human approval gate covers every irreversible action.
- **Versioning:** tool schemas are generated from the same Zod definitions as `/v1`, and the server reports its API version in server info.

**AI write policy**

&#91;embedded content: AI write policy · 1 decision, 7-day expiry\]

On approval, the stored operation re-runs with its original input and expected version as the requesting user, with the approver recorded; if the target changed since, the approval ends as `failed` and the AI must propose again.

`approvals` columns: `id`, `trip_id`, `requested_by`, `client_id`, `operation_id`, `input jsonb`, `target_version`, `status` (pending, approved, rejected, failed; expired is derived from expires\_at, never stored), `expires_at` (created + 7 days), `decided_by`, `decided_at`, `reason`. Expiry is checked whenever an approval is listed, read or decided, so no background job is needed; each state change is audited.

**Who decides.** The requesting user, or the trip owner for an approval on a trip, in a web session; tokens and MCP can never decide.

## Domain engines

The itinerary and rule checks are computed on every read from stored items, with no cache; only capacity is a hard write-time invariant.

**Itinerary (F-06)**

- Collect dated items the caller can see (`view=me` keeps items they own, attend, occupy, drive or are assigned to), convert each to its own local zone and bucket by local date. Lodging shows as check-in, check-out and a nightly "staying at" line.
- No cache: a trip of about 10 members and a few hundred items builds in milliseconds. Polled reads carry a SHA-256 ETag of the per-caller representation, so library edits and per-caller visibility always show and no column or trigger tracks freshness.

**Rule checks (warnings with stable codes)**

| Code | Rule |
| --- | --- |
| `overlap` | Two items overlap in time and share an attendee |
| `missing_transfer` | A person's next stop (a departure or a lodging check-in) is more than a set distance (default 10 km) from their last arrival, with no item linking them, e.g. landing in Dumaguete with no ferry to the Siquijor guest house |
| `non_refundable`, `non_changeable` | Badges from fare rules |
| `deposit_due` | Unpaid deposit or balance due within 7 days |
| `missing_add_on` | Transport with no checked baggage included and no baggage add-on; offers to create a task |
| `no_licensed_driver` | A vehicle in use has no driver, or the driver's person record lacks a licence |

Opening-hours and tight-connection checks are deferred.

The transfer check uses the `lat`/`lng` places already carry, so no region data is needed; persons gain a `driving_licence` field.

**Capacity (hard)**

- Occupants per unit ≤ `capacity` (rooms of 2, e-bikes of 5 including the driver); one room per member per night; at most one driver per vehicle.
- Assignments are saved per item as a whole board: `PUT /v1/items/{id}/assignments` with `If-Match` on the item's `boardVersion`. The service locks the item and its unit rows `FOR UPDATE`, checks only the final state, then replaces the allocations, bumps `board_version` and writes one audit event and one `item_board` snapshot. Allocation rows carry no version of their own, and tickets live in a separate table the save never touches.
- Checking the final state lets two people swap between full rooms, which per-allocation writes cannot do; the row lock still stops two concurrent saves from both passing (`409 capacity_exceeded`).

**Own RSVP.** A member answers through `PUT /v1/items/{id}/rsvp`, which takes the same item lock and bumps the item's board\_version (never its own version) but touches only the caller's attendee row and needs no `If-Match` (the last answer wins on one's own RSVP). The whole-board `PUT` stays with the item owner, organizers and the trip owner.

**Expenses (F-09, additional requirement 4)**

- Tribo records what was spent and how each expense is split among the members included, nothing more: no balances, debts, settle-up suggestions or payment tracking (scope decision R36). The payer is a recorded fact; the dashboard shows "my share", the sum of the caller's shares.
- Each expense stores its original amount and currency, an FX rate per major unit, and `trip_amount_minor = max(1, round half-up(amount × fx_rate × 10^(e_trip − e_orig)))`, with exponents from a static ISO 4217 table. Drop B takes the trip currency only (`fx_rate` = 1); the FX entry UI follows after the trip (Siquijor is PHP-only).
- Splits: equal, by weight, or itemised, one share per member included (the payer only if they share). Shares are frozen in `expense_shares` with the largest-remainder method, and the write path guarantees they sum to `trip_amount_minor`. Drop B ships equal and itemised; weight follows after the trip.
- Owners and organizers can edit or void any expense; members edit their own. Every change is audited (PRD change: no approval step). The trip currency locks once any expense or budget line exists.
- Budget (1b): planned lines per category, replaced whole under `trips.budget_version`; actual = non-voided expenses by category.

**Clone (F-01)**

- Input: new start date and one option, "include my private items". Every date shifts by the day delta while keeping each item's local wall-clock time, then re-resolves to UTC in that item's zone.
- Copied: items, units, tasks (reset to open), checklists, budget categories, members and roles. Library places and vendors are referenced by id, not copied.
- Never copied: booking refs, tickets, allocations, expenses, files, overlays and other members' private items.
- The clone runs in one transaction, sets `cloned_from`, and logs one `create` event per entity under a shared `request_id`.

## Documents, encryption and retention

Uploaded files and sensitive fields are encrypted with one app key; retention and erasure work by deleting rows, snapshots and blobs.

**Uploads and downloads (F-10)**

- `POST /v1/trips/{id}/files` streams multipart uploads (default limit 25 MB), sniffs the type against an allowlist (PDF, JPEG, PNG, HEIC, WebP) and records size and SHA-256.
- Kinds `id`, `ticket` and `voucher` are flagged `sensitive`; per-file visibility (shared or private) uses the same predicate as items.
- `GET /v1/files/{id}/content` re-checks permission on every request and streams the decrypted bytes with `Cache-Control: private, no-store`, except for files the user marks for offline copy (see Web app).

**Encryption**

| Data | Protection |
| --- | --- |
| Uploaded files | AES-256-GCM, streamed in chunks, with the app key |
| Person fields (emergency contact; passport and ID numbers in slice 1b) | AES-256-GCM `bytea` columns |
| Trip fields (booking refs, ticket numbers, card last-4) | AES-256-GCM `bytea` columns |

- The app key is 32 bytes, loaded from a Docker secret file and never stored in the database. If it ever needs rotating, an offline script re-encrypts columns and files; the key version stored with each value lets it run in steps.
- Backups hold ciphertext only. The admin keeps a copy of the app key apart from the backups; losing it loses all sensitive data, which the admin console states at setup.

**Retention (additional requirement 11)**

- One admin setting, `document_retention_days` (default 30, never above `audit_retention_days`). A sensitive file is due at trip end date + N days; any soft-deleted file, or a file of a deleted trip, is due N days after its deletion. Due dates are computed by the daily job and never stored.
- The daily job (after the trip; nothing is due before mid-December) deletes due blobs, sets `purged_at`, replaces the filename with `purged` and writes a content-free `purge` event to the trip's audit chain. It purges every due file before a trip's chain can retire.
- Non-sensitive files live as long as their trip. Once a deleted trip's audit chain is retired, the job deletes the trip's rows in FK order, then placeholders left with no membership, leaving one `purge` record in the platform chain; an archived trip stays readable.
- Sessions are deleted 30 days after revoke or expiry, along with expired idempotency keys and OAuth rows.

## Web app, offline and notifications

The SPA is mobile-first and reads the active trip offline from slice 1a, before the trip; queued offline edits arrive in release 3 and push notifications in release 2.

**Screens**

| Route | Content |
| --- | --- |
| `/trips` | My trips (people join only through invite links) |
| `/trips/:id` | Dashboard: countdown, next item, open tasks, due-soon reminders, my share, warnings |
| `/trips/:id/plan?view=me\|group` | Day-by-day itinerary with warning badges |
| `/trips/:id/stay`, `/rides` | Room and vehicle boards with drag-to-assign and capacity counts |
| `/trips/:id/money` | Expenses and each one's split; budget vs actual in 1b |
| `/trips/:id/docs`, `/members` | Files, members, roles, invite links |
| `/items/:id` | Detail, my private overlay, history panel with diff and restore |
| `/library`, `/approvals`, `/admin` | Library, AI approval inbox, admin console |

- **Accessibility:** WCAG 2.2 AA with accessible headless primitives, visible focus, 44 px touch targets and reduced-motion support.
- **Localisation:** all strings in one plain message map, dates and money through `Intl` in the trip's zone and currency; an ICU library comes in only with a second locale.

**Offline (slice 1a: read; release 3: edits)**

- The service worker precaches the app shell. "Save trip offline" fetches `GET /v1/trips/{id}/offline-bundle` (my and group itinerary, item details, contacts, file metadata) into IndexedDB, plus any files the user marks.
- On reconnect the client sends `If-None-Match` with the bundle's SHA-256 ETag and refetches only when it changed.
- IndexedDB is not encrypted on the device, so the bundle masks sensitive fields (booking refs, ticket and ID numbers, emergency contacts) and offline copies of sensitive files are opt-in per file and are deleted on sign-out or when the server reports them purged.
- Release 3 adds an IndexedDB outbox of writes carrying `If-Match` versions; a `412` opens a per-field "mine vs theirs" merge prompt.

**Reminders in 1a (F-08).** Task due dates and overlay `reminder_at` times feed a "Due soon" list on the dashboard and in `/v1/me/tasks`; nothing is pushed until release 2.

**Notifications (F-13, release 2)**

- Release 2 adds an `outbox` table written in the change's transaction and drained in-process right after commit (no worker). Recipients are the affected people (assignees, attendees, occupants, drivers of the changed item, minus the actor), filtered through the visibility predicate.
- Delivery: an in-app `notifications` table and Web Push (VAPID) to stored subscriptions; a daily digest is a per-user option. On iPhone, Web Push works only after the PWA is added to the Home Screen, so onboarding prompts for it.
- Push payloads carry a title and link only, never sensitive or cost fields.

## Operations

One host runs everything; operations come down to nightly backups you can restore, readable logs and a few rate limits.

| Area | Design |
| --- | --- |
| Hosting | Any Docker host in one of the deployment modes (Architecture). The reference deployment is a VPS with its domain on Cloudflare, DNS only. Domain and host costs accepted. |
| Backups | Nightly `pg_dump` and `rsync` of the upload volume to a disk you own, 7 days kept; the app key is copied separately. Up to a day of edits can be lost (PRD change: no point-in-time restore). |
| Restore check | Quarterly manual checklist: restore the latest dump into a scratch Compose project, run chain verification and open the Siquijor trip. |
| Migrations | Run at app start under an advisory lock; expand/contract steps so a rollback never needs a down-migration. |
| Logs | pino JSON logs with field redaction; every line and audit event carries the request id. |
| Health | Admin console page reads Postgres (last purge run, failed purges, pending approvals, storage used) and process stats (uptime, memory). No metrics server. |
| Rate limits | In-memory, in the app: login lockout per username, 10 logins/min per IP, and one write limit (120/min) per user or OAuth client; `429` with `Retry-After`. |
| Performance | p95 < 300 ms reads, < 500 ms writes; dashboard in one call (`GET /v1/trips/{id}/dashboard`); initial JS ≤ 200 KB gzip so the dashboard renders in < 2 s on 4G. |
| Hardening | Strict CSP, `__Host-` cookies, dependency and container scanning in CI, secrets only via Docker secrets. |

## Testing and acceptance

The Siquijor trip is the acceptance test. Slice 1a must pass items 1–10 on web and REST before 11 Nov; slice 1b must pass all 14, including MCP, before MVP is called done.

| Layer | Covers |
| --- | --- |
| Unit | Policy matrix, split rounding and share sums, clone date shifting, every rule check |
| Integration (real Postgres) | Write-path atomicity (a failed audit insert rolls back the change), append-only triggers, chain hashing, capacity row lock |
| Contract | OpenAPI changelog diff, registry coverage (every route and tool has an operation id), MCP tool schema snapshots |
| Privacy properties | Randomised trips, roles and visibilities; no private row reaches another user on any surface |
| End to end | Playwright web flows; a scripted MCP client doing OAuth with a Client ID Metadata Document, then tool calls |

**Siquijor acceptance run**

- [ ] Owner (MFA on) creates "Siquijor" for 11–14 Nov 2026, PHP, Asia/Manila
- [ ] 10 travellers present via invite link or as placeholders; one placeholder later claimed
- [ ] PAL Manila → Dumaguete (11 Nov) and return (14 Nov) show non-refundable and non-changeable; missing baggage add-on becomes an open task
- [ ] Dumaguete → Siquijor ferry linked to the flight arrival; removing it raises `missing_transfer`
- [ ] Lagwerta Guest House with 5 rooms × 2; an 11th occupant is rejected; vendor saved to the library
- [ ] 2 e-bikes × 5 seats incl. driver; a 6th rider is rejected; an unlicensed driver is flagged
- [ ] Paliton Beach and other spots as library places; activities with RSVP on day plans
- [ ] Expenses across airfare, lodging, e-bikes, food and fees, each split equally or itemised among the members included; each member sees their share
- [ ] A member's private task is invisible to others on web and REST (1a) and on MCP (1b)
- [ ] With the phone offline, a member who saved the trip opens the itinerary, room and e-bike assignments, contacts and the tickets they marked for offline
- [ ] Via MCP: an AI adds an activity (applies, shown "via AI"), then asks to delete an item (pending until the owner approves)
- [ ] An item is restored to an earlier version from the history panel
- [ ] A second trip is cloned with a new start date; bookings, payments, files and private items are absent
- [ ] On-demand verification passes for every audit chain

## Delivery plan

The trip departs 11 Nov 2026, 26 days from this draft, so MVP splits in two: a trip-ready slice the group can use on Siquijor, then the rest of the PRD's release 1 after the trip.

&#91;embedded content: delivery roadmap · 4 phases, 2 gates\]

Slice 1a covers everything the group touches during the trip; MCP, clone and retention matter only afterwards, and the clone test needs a finished trip to copy anyway.

- **1a scope, in two drops:** Drop A by Sun 1 Nov (planning-ready): identity and invites, roles and visibility, trips and all item types with RSVP, rooms and e-bike boards with capacity, itinerary with warnings, library search and inline create, audit log (append-only + hash chain), REST v1, responsive web. Drop B by Sun 8 Nov (trip-ready): per-passenger tickets, expenses with splits, files, emergency-contact reveal, the offline read bundle, overlays and the due-soon list.
- **1b scope:** MCP server with OAuth discovery and approvals, history panel and restore, clone and templates, retention purge, budget vs actual, checklist entries, library merge, personal access tokens, MCP client allowlist, audit export and verification, ID and passport fields with consent capture, break-glass with step-up, erasure, template apply, OAuth consent and connections, Idempotency-Key on the remaining create operations, admin console polish.
- **Release 2 and 3:** as in the PRD (notifications, calendar, map, import, comments, polls, exports, search; then offline edits, weather, webhooks, post-mortem).
- **Built in 1a regardless:** the operation registry, versioned snapshots and audit write path, so 1b adds adapters rather than reworking the core.

**After the trip, before 1b** (approved 17 Oct 2026): the web admin console (the `tribo admin` CLI covers accounts until then), library browse and edit pages, trip archive, file purge, the FX entry UI, weight splits and the daily retention job. None of it is needed on the island.

**Schedule.** One developer with Claude sessions running during work hours, about 94 focused hours (weekends and 7–10 pm weekdays): Sprint 0 exit Thu 22 Oct · Drop A Sun 1 Nov · Drop B Sun 8 Nov · Mon–Tue 9–10 Nov fixes and member onboarding only.

## PRD gaps and open decisions

The three product calls were accepted on 16 Oct 2026 (marked **Decided**); the rest are resolved in this design and should be folded back into the PRD. Rows marked "Decided (PRD change)" come from the accepted design review. The three API review calls were accepted on 16 Oct 2026, so no rows remain open.

| Topic | Gap or conflict | Proposal | Status |
| --- | --- | --- | --- |
| MVP timing | Full release 1 is unlikely in 26 days before the trip | Ship 1a before 11 Nov, 1b after (Delivery plan) | **Decided** |
| Admin and private history | Admins "view all audit logs", yet private-item history is owner-only and the privacy guarantee includes admins | Admins see metadata only (time, actor, action, entity type) for private items; titles and diffs need break-glass | **Decided** |
| Owner MFA | Any user who creates a trip becomes an owner, so MFA applies to nearly everyone | Keep it: TOTP setup is one-time and protects passport data | **Decided** |
| Clone and private items | "Unless the owner opts in" would copy other members' private items | Opt-in covers only the owner's own private items | Resolved here |
| Erasure vs append-only audit | RA 10173 erasure conflicts with an immutable log | Audit rows hold no field values; erasure deletes the person's rows and snapshots | Resolved here |
| FX rates | No rate source named; a self-hosted box may lack outbound access | Manual rate, prefilled from the last one used; FX UI hidden until a non-trip-currency expense | Resolved here |
| Expense approval | PRD says organizers approve expenses but not what approval changes | No approval step; expenses count at once and organizers can edit or void any | Decided (PRD change) |
| MCP session id | Spec 2026-07-28 carries context per request; a session id may be absent | Audit stores whatever session or correlation id the client sends; may be empty | Resolved here |
| Restore after purge | Restoring a version can reference a purged file | Restored item shows a "purged" placeholder | Resolved here |
| PRD wording | Admin console bullet reads "no outbound email and roles" | Read as "share directly (no outbound email); manage roles"; fix in PRD | Edit PRD |
| Backups | PRD asks for 7-day point-in-time restore | Nightly dumps to a disk you own; up to a day of edits can be lost | Decided (PRD change) |
| Tamper evidence | PRD asks for hash chaining but not how it is checked | Chain kept; verified on demand from the admin console; no off-box anchor | Decided (PRD change) |
| Service accounts | PRD lists service accounts, OAuth client credentials for the API and an on\_behalf\_of audit field | Deferred; OAuth serves MCP only and REST takes web sessions or personal access tokens, so no client credentials or on\_behalf\_of column in MVP | Decided (PRD change) |
| Admin view-as | PRD admin console lists a read-only "view as" mode | Dropped; break-glass with a reason covers support access | Decided (PRD change) |
| MCP resources and prompts | PRD lists 2 resources and 2 prompts | Tools only in 1b; add resources or prompts if a client uses them | Decided (PRD change) |
| Offline on the trip | Offline reading matters most on the island, but the offline read bundle was scheduled for 1b, after the trip | Offline read bundle moved into slice 1a | Decided |
| Contract source | The design says Zod generates OpenAPI, yet a 4,400-line hand-written draft now exists and will drift from code | Code-first: write Zod schemas and registry stubs first, generate and review the spec, retire the hand draft | **Decided** |
| Slice 1a API scope | 105 of the draft's 125 operations sit in 1a, with 25 days to the trip | Keep per-passenger tickets in 1a; move budget vs actual, checklist entries, library merge, personal access tokens, the MCP client allowlist and audit export/verify to 1b | **Decided** |
| Pending invites | The /trips screen lists invites to accept or decline, but invites are links with no addressee | Drop the list; people join only through the link | **Decided** |
| Request schemas | Output schemas reused for input reject valid creates in OpenAPI 3.1 and accept null amounts | Separate input, patch and output schemas per resource | Resolved here |
| Masked writes | A masked null sent back in a form would overwrite the real value | Reject writes to fields masked for the caller (409 masked\_field\_write) | Resolved here |
| Offline sensitive fields | The bundle carried booking refs and emergency contacts into unencrypted IndexedDB | Mask sensitive fields in the bundle | Resolved here |
| Room swaps | Per-allocation writes cannot swap two people between full rooms | One PUT per item saves the whole board, checked on its final state | Resolved here |
| Time input | Clients and AI had to compute UTC offsets | Write wall-clock time plus zone; the server returns the instant | Resolved here |
| Irreversible actions by token | A leaked write token could purge files | File purge and approval decisions are session-only | Resolved here |
| Secrets in URLs | Invite and reset tokens in API paths reach logs and Referer headers | Tokens in request bodies, log redaction, no-referrer | Resolved here |
| Restore races | Restore and archive had no version check | If-Match required; restore undeletes children from the same request | Resolved here |
| Audit IP and user agent | Hash-chained, append-only rows holding IP and user agent could never be erased under RA 10173 | Keep both in the JSON logs, joined by request\_id; audit rows hold ids and metadata only | Decided (PRD change) |
| Erasure vs shared ledger | Deleting a person's rows breaks other members' expenses and shares | Scrub personal fields, keep the row as a tombstone, delete their snapshots | Resolved here |
| Copied columns | Trip owner, a member's account and who paid were each stored twice and could disagree | One home each: the owner membership, persons.user\_id, expenses | Resolved here |
| Offline refresh signal | A content\_version column bumped by triggers made every write lock the trip row, risking deadlocks | A SHA-256 ETag of the per-caller representation; no stored counter (R12, R40) | Resolved here |
| Board saves and tickets | Replacing the assignment board would wipe ticket numbers if they lived on allocations | Tickets stay a separate table; allocation rows carry no version, and `items.board_version` covers the board and RSVPs (R26) | Resolved here |
| Stored purge date | A per-file purge date had to be recomputed whenever trip dates or the setting changed | The daily job computes it from trip end + retention days | Resolved here |
| Ciphertext swaps | An encrypted value copied to another row would still decrypt | Bind AAD to table, column and row id; store the key version with each value | Resolved here |
| Postgres version | "Current major" left UUIDv7 generation to a custom function | Target PostgreSQL 18+, which has uuidv7() built in | Resolved here |
| ID and passport | Storing ID numbers needs consent capture, reveal and encryption UI before 11 Nov | Move ID and passport fields with consent capture to 1b; the columns and a consent CHECK exist now | Decided |
| Sensitive-field reveal | The PRD masks sensitive fields by default with an audited reveal; the design had no reveal operation | Reveal in 1a for booking refs, ticket numbers, card last-4 and emergency contacts; a reveal audit event names fields, never values | Decided |
| Person visibility | Library people search exposed every person platform-wide | person\_visible(): the person, the creator and co-members; sensitive fields to the person and trip owners and organizers | Decided |
| Children of private items | Files, tickets and allocations of a private item were not covered; a shared file on a private item leaked | Children inherit item\_visible(); expenses stay visible with the item link nulled | Decided |
| Member rights and RSVP | The matrix was unclear on creation, and a member's RSVP needed the whole-board save | Members create items they own and edit own or assigned ones; a separate own-RSVP operation | Decided |
| Reminders (F-08) | reminder\_at was stored with no 1a surface | Due-soon list on the dashboard and in /v1/me/tasks; push in release 2 | Decided |
| MCP tools | The tool table kept propose\_change after the PRD review replaced it | One tool per operation; destructive ones go to approval | Decided |
| Hosting | The design assumed one kind of host | Deployment modes (public host, Cloudflare DNS only, proxied, tunnel, private); MCP only in reachable modes | Decided |
| Operation inventory gaps | 15 gaps (G1–G15) the sources left undefined: password change, consent, ETags, ticket rights, approvers, break-glass, erasure, MCP switch, library edits, templates, meta endpoints, ownership, reveal scope (the debt-rights part lapsed with R36) | All accepted as listed in the inventory; step-up moves to 1b with break-glass, and MCP on/off stays a deploy setting instead of a new column | Decided |
| Scope vs capacity | Full 1a (93 operations then, 86 after R36) needed an estimated 17–23 days of the owner's time; about 12 are available before go-live | Ship 68 operations in two drops (A by 1 Nov, B by 8 Nov); the other 18 follow right after the trip | Decided |
| Debts and settle-up | Tracking debts, balances and settle-up payments is more than the group needs and adds a second money ledger | Record expenses and each one's split only; the dashboard shows my share (R36). Nine operations and the debts table removed | Decided (PRD change) |
| Schema review | Defects, logic gaps and one-off mechanisms in the schema and operation list (R1–R41) | All fixed under one rule; record in claude/design/schema-review-2026-10-17.md | Decided |

Simplicity and cost review of this design: Design review
