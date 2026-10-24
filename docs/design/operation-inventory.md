# Tribo — Operation inventory

Oct 17, 2026 · @Eris Sales

## Summary

The registry declares **130 operations**. Before the trip, slice 1a ships **68 in two drops: Drop A (46 operations, planning-ready by Sun 1 Nov) and Drop B (22, trip-ready by Sun 8 Nov)**. 18 operations follow right after the trip and 44 stay in 1b. Each operation becomes one backlog story and one registry stub; 18 rows map to the 15 MCP tools in the design. The per-operation detail lives only in the registry (17 Oct schema review, R36 removed the nine debt and settle-up operations).

| Module | Drop A | Drop B | After trip | 1b | Total |
| --- | --- | --- | --- | --- | --- |
| Auth & identity | 6 | 0 | 0 | 3 | 9 |
| Me | 3 | 1 | 0 | 5 | 9 |
| Trips | 6 | 1 | 1 | 1 | 9 |
| Members & invites | 9 | 0 | 0 | 0 | 9 |
| Items | 7 | 3 | 0 | 4 | 14 |
| Units & assignments & tickets | 6 | 5 | 0 | 0 | 11 |
| Itinerary | 1 | 0 | 0 | 0 | 1 |
| Expenses | 0 | 5 | 0 | 2 | 7 |
| Files | 0 | 6 | 1 | 0 | 7 |
| Library | 6 | 1 | 7 | 9 | 23 |
| History & restore | 0 | 0 | 0 | 8 | 8 |
| Approvals | 0 | 0 | 0 | 4 | 4 |
| Admin | 0 | 0 | 9 | 8 | 17 |
| Health/meta | 2 | 0 | 0 | 0 | 2 |
| **Total** | **46** | **22** | **18** | **44** | **130** |

**Delivery drops** (approved 17 Oct 2026, sized to about 94 focused hours before go-live)

- **Drop A, planning-ready by Sun 1 Nov:** sign-in and MFA, invites and members, trips, all item types with RSVP, rooms and e-bike boards, itinerary, library search and inline place or vendor creation. The group joins and enters bookings from 2 Nov.
- **Drop B, trip-ready by Sun 8 Nov:** tickets, expenses with splits, files, emergency-contact reveal, the offline bundle, private overlays and the due-soon list. Idempotency-Key is honoured on expenses.create and files.upload only; FX stays at the trip currency and splits are equal or itemised.
- **After the trip:** the web admin console, library browse and edit pages, trip archive and file purge, plus the FX entry UI, weight splits and the daily retention job. Until the console ships, the `tribo admin` CLI creates users, issues reset links, resets MFA and unlocks accounts.
- The Slice column reads 1a, After trip or 1b; the `drop` field of the registry says A or B for each 1a operation.

**How to read the registry.** One entry per operation in `packages/contract/src/operations/*.ts`, with its notes and R- and G-references inline. The fields that need a key (the registry spells them in camelCase):

- **roles** use the trip role matrix: owner, organizer, member, viewer. *self* means the caller acting on their own data; *admin* means platform admin, which gives no trip access.
- **auth**: *session* = web cookie + CSRF; *pat:read* / *pat:write* = personal access token scope (1b); *oauth:mcp* = also reachable through the MCP tool named in **mcp\_tool** (1b); *public* = no sign-in. OAuth tokens work only at /mcp.
- **if\_match** names the counter the write must match: `version`, `board_version`, `budget_version`, `version_or_new` (overlay upsert) or `no`.
- **idempotent**: `key` = takes Idempotency-Key (creates only), `natural` = safe to repeat, `no` = auth acts and reveals, never replayed.
- **destructive** and **mcp\_approval** are separate flags: an MCP call with `mcp_approval = yes` becomes a pending approval.
- **slice** is 1a, after-trip or 1b; **drop** says A or B for each 1a operation.

**Conventions applied**

- **Ids:** `<resource>.<verb>`, with nested resources dotted (`items.assignments.replace`, `library.people.update`). MCP tool ids are reused as they appear in the design. Path parameters use named ids (`{itemId}`); the API renders TypeID prefixes.
- **JSON** is camelCase, and each resource has `<X>Input`, `<X>Patch` and `<X>` Zod schemas. Writes take times as wall-clock time + IANA zone.
- **If-Match:** any write that could overwrite a change it hasn't seen names its aggregate's counter: a root's `version`, an item's `boardVersion` (assignment board) or a trip's `budgetVersion`. Missing → 428 `if_match_required`; stale → 412 `version_conflict` with the current body. `items.rsvp` replaces only the caller's own answer and takes none; invites and tokens are credentials with no counter.
- **Idempotency-Key** is taken only by operations that create something (24 h per caller; same key with a different body → 422). Other writes are naturally idempotent through If-Match or a one-way transition; auth acts and reveals are never replayed, and shown-once secrets are never stored for replay (`redacted: true`). Drop B honours the key on `expenses.create` and `files.upload`; the other creates follow in 1b.
- **Destructive:** deletes, voids, removals, role changes, revokes, purge, merge and MFA reset carry the registry's destructive flag. Through MCP, destructive operations and every reveal become pending approvals, answered with `approval_required` and an approval id.
- **Session only, never tokens or MCP:** all `admin.*`, `files.purge`, `approvals.approve` / `reject`, token management and OAuth consent.
- **Masking:** sensitive fields (booking ref, card last-4, ticket number, emergency contact; ID and passport in 1b) are masked for every caller. The plaintext comes only from a `*.reveal` operation, which is audited. A write that sets a field masked for the caller fails with 409 `masked_field_write`.
- **Outside the registry:** the `/mcp` transport, OAuth AS endpoints (authorize, token, revocation), `/.well-known/*` metadata, and the SPA pages `/join#<token>` and `/reset/<token>`. The OAuth library and the MCP SDK serve these, so they get no operation id.

## Where each operation is defined

The operation registry (`packages/contract/src/operations/*.ts`) is the one list of operations: roles, auth, write rules, slice, drop, MCP tool and notes per entry ([decision 0029](../decisions/0029-registry-is-the-operation-source.md)). It replaced `operations.csv`, which the registry had been checked against until Drop B; the per-module tables that used to sit here were removed on 17 Oct rather than kept as a second copy. Read one module's file for an area, or `docs/backlog.md` for a backlog drop.

## Decisions

All 15 gaps were decided on 17 Oct 2026 as listed. Two were adjusted to fit the design: step-up moves to 1b with the reads it guards (G8), and MCP on/off stays deploy configuration instead of a new settings column (G10).

| # | Gap | Decision | Affects |
| --- | --- | --- | --- |
| G1 | No self-service password change; recovery is admin-only | Add `me.password.change` (session only, current password required, revokes other sessions), 1a | `me.password.change` |
| G2 | The consent screen, the allowlist's `enabled` flag and grant revocation have no operations | Consent interaction get/decide backing the SPA consent page; a user can list and revoke their MCP grants; an admin can disable a client without deleting it. All session only, 1b | `oauth.interaction.*`, `connections.*`, `admin.clients.update` |
| G3 | If-Match is undefined for upserts with no prior row (overlay) and for multi-row saves (budget lines) | Overlay PUT: If-Match only when an overlay exists, `If-None-Match: *` to create. Budget PUT: If-Match on `trips.budget_version`, bumped on every replace (R35) | `overlays.put`, `budget.replace` |
| G4 | The role matrix is silent on tickets | Item owner, organizers and trip owner manage tickets. A member may edit seat and baggage on their own ticket, never ticketNo | `tickets.*` |
| G5 | The matrix covers expenses, not debts; markPaid has no path | Lapsed: debts, balances and settle-up were removed from scope (R36), with `debts.*` | none |
| G6 | Who may decide an approval ("pending until the owner approves") | The requesting user in a web session, plus the trip owner for trip-scoped approvals | `approvals.*` |
| G7 | The admin audit query has no slice (only export and verify are named 1b) | 1b with export; 1a has no audit viewer beyond the append-only write path | `admin.audit.query` |
| G8 | Break-glass has no API shape | A `Break-Glass-Reason` header on history and audit reads, accepted only within 10 minutes of `auth.stepUp` (stamped as `sessions.step_up_at`); each read logs `break_glass`. Step-up moves to 1b with the reads it guards | `auth.stepUp`, `*.history`, `admin.audit.query` |
| G9 | Erasure is designed but has no operation | Admin-only, session-only `admin.people.erase` with If-Match, 1b (admin console polish) | `admin.people.erase` |
| G10 | "Enable MCP" has no setting column | No new column: MCP on/off is the `TRIBO_MCP_ENABLED` deploy setting, kept with the deployment mode; start-up refuses it in Private mode and the admin health page shows it read-only (1b) | `admin.health`, deploy config |
| G11 | No rule on who edits or deletes shared places and vendors | Any signed-in user creates and edits, audited on the platform chain. No delete in MVP: merge handles duplicates | `library.places.*`, `library.vendors.*` |
| G12 | Templates can be stored but nothing applies them | `library.templates.apply` into an existing trip (owner, organizer), 1b | `library.templates.apply` |
| G13 | No liveness or spec endpoint for Compose and the contract workflow | Public `GET /healthz` with no details; `GET /v1/openapi.json` for signed-in users | `meta.*` |
| G14 | No owner transfer or leave-trip; the schema allows one owner per trip | Owner sets another member (with MFA) to owner, and is demoted to organizer in the same transaction. Any non-owner may remove their own membership | `members.setRole`, `members.remove` |
| G15 | Reveal is a POST that returns data; its PAT scope is unstated | Require write scope, since reveal is an audited sensitive action. Through MCP it always goes to approval (1b) | `*.reveal` |

*Not in this inventory:* the MCP transport, OAuth AS endpoints and `/.well-known/*` metadata. These come from the MCP SDK and node-oidc-provider, so they have no operation id. Release 2 and 3 operations (notifications, exports, comments) are also left out.
