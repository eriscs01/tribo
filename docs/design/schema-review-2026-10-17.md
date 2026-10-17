# Tribo — design rule and schema review (17 Oct 2026)

Applies to `claude/db/0001_init.sql` and `claude/api/operations.csv`; R-numbers are referenced from comments in both. Three passes: R1–R27 fixed defects, R28–R36 fixed logic and applied the debts scope decision, R37–R41 brought everything under one rule. All schema rules run on PostgreSQL 18.4 with positive and negative tests (as `tribo_app`, plus superuser setup for aged data).

## The rule

**Every fact has exactly one owner, and only that owner stores, changes, versions and enforces it.** Nothing is copied, and nothing is enforced in two places. Applied to each concern:

| # | Concern | How the rule applies |
|---|---|---|
| 1 | Records | Each row is a **root** (own endpoints; version, created/updated/deleted columns; soft delete; one audit row and one snapshot per write), **owned** by a root (no version or soft delete; replaced with the root; inside its snapshot), a **credential** (revoked or expired, never versioned), or a **log** (append-only). Actor columns are left out where one participant is the only possible writer, because they would copy the owner column. |
| 2 | Enforcement | The database declares what one row or key can express: types, domains, CHECK, FK, UNIQUE. Every rule that needs other rows, the caller or the clock lives once, in the service's write path: permissions, visibility, lifecycle, share sums, capacity, currency lock, retention of trip data. The audit schema owns its own integrity (chaining, append-only, timestamps, retired chains), so its triggers and SECURITY DEFINER purges are the only database code that acts. |
| 3 | People | Inside a trip a person is their **membership**: what they own, are shared, are assigned, pay or keep private there. Outside a trip a person is their **account**: credentials, actor columns, personal templates. |
| 4 | Derived state | Computed, never stored: archived ⇔ `archived_at`; an approval is expired ⇔ pending and past `expires_at`; a file is sensitive ⇔ its kind; a read is fresh ⇔ its SHA-256 ETag matches. No balances. |
| 5 | Concurrency | One counter per aggregate, named by If-Match: `version` on each root, `items.board_version`, `trips.budget_version`. Snapshots are keyed by the same aggregate and counter. Any write that could overwrite a change it hasn't seen carries If-Match; replacing a single value only the caller owns (their RSVP) can't, so it doesn't. |
| 6 | Idempotency | Idempotency-Key only on operations that create something. Other writes are naturally idempotent through If-Match or a one-way transition. Auth acts and reveals are never replayed, and secrets are never stored for replay. |

## Scope decisions

**R36 — expenses only.** Tribo records expenses and each one's split among the members included in it. It never works out who owes whom, suggests transfers or tracks payments. Debts, balances and settle-up are gone; the dashboard shows "my share". The payer is a recorded fact, not input to netting.

**Build split.** Build now whatever would leave unrecoverable data or force every write path to be reworked; defer what can be added later without changing data already written.

| Mechanism | When | Why |
|---|---|---|
| The write path: soft-delete filter, If-Match, field encryption, audit row, snapshot, cross-row rules (share sums, currency lock, capacity, archived) | A | History and audit can't be backfilled; plaintext written now stays in backups; If-Match touches every endpoint and client later |
| Hash chain and chain routing | A (free) | Database triggers already in the migration |
| Per-trip placeholder claim | A | It is the invite-accept flow |
| Idempotency middleware | B, on `expenses.create` and `files.upload`; the rest 1b | Can be added later without touching data; duplicate retries matter on trip mobile data. R2 redaction work moves to 1b |
| FX on expenses | After the trip; Drop B takes the trip currency only (`fx_rate` = 1) | Siquijor is PHP-only; fields exist |
| Weight split | After the trip; Drop B ships equal + itemised | Same shares and rounding; only a form |
| Retention job | After the trip | Nothing is due before mid-December |
| History/restore UI, chain verify, merges, erasure, MCP, PATs, approvals | 1b | Can be added later; snapshots and audit rows already accumulate |

## Change log

| # | Problem | Resolution | Where |
|---|---|---|---|
| R1 | Signed-in claim violated `persons.user_id UNIQUE` | Superseded by R28 | — |
| R2 | Idempotency cache stored shown-once secrets and reveal plaintext; public ops had no caller | Secret fields never stored; replay returns `redacted = true`; Set-Cookie never replayed; anonymous accept caller = `invite:<id>` | `idempotency_keys`; CSV |
| R3 | MFA reset on an active admin failed `users_admin_needs_mfa` | Same write disables the admin | `admin.users.mfaReset` |
| R4 | `members.add` could add an account holder without an invite | Placeholders only | `members.add` |
| R5 | Emergency contact in plaintext JSONB | `emergency_contact_enc` | `persons` |
| R6 | Emergency contacts unrevealable during the trip | `library.people.reveal` in Drop B | CSV |
| R7 | Budget ETag from max line version | Superseded by R35 | — |
| R8 | FX minor units unspecified | Static ISO 4217 exponent table; formula on `trip_amount_minor` | `expenses` |
| R9 | Trip currency editable after money recorded | Write path refuses once any expense or budget line exists (rule 2) | `trips.update` |
| R10 | `debts_paid_pair` one-directional | Removed with debts (R36) | — |
| R11 | Share sum not enforced | Write path guarantees it (rule 2) | `expenses.*` |
| R12 | Offline ETag missed library edits, not per caller | SHA-256 of the per-caller representation for every polled read (rule 4) | `trips` |
| R13 | Platform chain never purged; login_failed contention | Monthly `auth:YYYY-MM` chains; shared `audit.retire_chain` | audit |
| R14 | Audit `action` missing values | merge, erase, revoke, password_change, mfa_enrol, step_up | `audit_events` |
| R15 | Approved MCP reveal could not reach the client | Re-call with `approvalId` within 10 min, single use | `approvals.consumed_at` |
| R16 | Timed/all-day fields could mix | Two CHECKs | `items` |
| R17 | `iana_tz` accepted `PST`, `UTC+8`, POSIX specs | Shape check before parsing | `is_valid_tz` |
| R18 | `is_member` ignored deleted trips | Joins `trips` | visibility functions |
| R19 | Creator saw a person after it gained an account | Creator clause only for placeholders | `person_visible` |
| R20 | Erasure left PII outside `persons` | Scope defined | `admin.people.erase` |
| R21 | Unit cascade never fired (soft delete) | Explicit deletes by `units.delete` / `members.remove` | `allocations` |
| R22 | Rejoin created a second membership id | `UNIQUE (trip_id, person_id)` over all rows; rejoin undeletes | `memberships` |
| R23 | `trips.update` could archive | Only `trips.archive` | `trips` |
| R24 | Deleted blobs never purged | Purged after `document_retention_days`; filename → `purged` | `files` |
| R25 | `/join/<token>` leaked to proxy logs | `/join#<token>` | `invites` |
| R26 | RSVPs caused 412 on item edits | Board and RSVPs on `items.board_version` | `items` |
| R27 | Shared MCP tool; `destructive = approval` | `mcp_approval` column | CSV |
| R28 | Claiming a placeholder handed over every trip it was in | Per-trip claim; invite pre-link FK to the trip's membership | `persons`, `invites` |
| R29 | Archived trips writable; writes after retirement restarted the chain | Archive one-way and read-only; retirement freezes the trip through the audit trigger; files purge first; `document_retention_days ≤ audit_retention_days` | `trips`, audit |
| R30 | Audit `chain_key` CHECK would re-validate old rows on restore | Dropped; trigger routes once | audit |
| R31 | Callers could backdate audit events | Trigger forces `now()` (superuser excepted); `pg_catalog.sha256` qualified | `audit.chain_event` |
| R32 | Removed owner's private items orphaned; ownerless trip on erasure | Removal soft-deletes them (rejoin restores); erasure needs owner transfer | `memberships`; erase |
| R33 | Vendor debt payment and expense drifted | Removed with debts (R36) | — |
| R34 | Deleted trips' rows and expired sessions kept forever | Write-path retention purge after retirement; sessions deleted 30 days after expiry | job; `sessions` |
| R35 | Budget concurrency coupled to the audit log | `trips.budget_version` | `trips` |
| R36 | Payment tracking out of scope | Debts, balances, settle-up removed | — |
| R37 | Cross-row rules split between triggers and service | Share-sum and currency-lock triggers and `tribo.purge_deleted_trip` moved to the write path; `tribo` schema has no triggers (rule 2) | schema |
| R38 | Budget lines versioned though only edited as a whole; MCP clients hard-deleted | Budget lines are owned rows (`UNIQUE (trip_id, category)`, snapshot `trip_budget`); `mcp_clients` soft-deletes (rule 1) | `budget_lines`, `mcp_clients` |
| R39 | Trip participation referenced users in some tables and memberships in others | `items.owner_membership_id`, `item_shares.membership_id`, `files.owner_membership_id`, `overlays.membership_id`, all with same-trip composite FKs; `item_visible` resolves the caller's membership (rule 3) | items, files, overlays |
| R40 | Derived state stored | No `archived` status (`archived_at` only, requires completed); no `expired` approval status or `expire` action; no `contentVersion` (rule 4) | `trips`, `approvals`, audit |
| R41 | If-Match and idempotency columns used ad-hoc values | `if_match` names the counter (`version`, `board_version`, `budget_version`, `version_or_new`, `no`); `idempotent` = `key` only on creates, `no` for auth acts and reveals, `natural` otherwise (rules 5–6) | CSV |

## Research notes

- **R15.** MCP 2025-11-25 tasks support deferred results but are experimental, and SEP-2663 redesigns them; re-calling with `approvalId` works with any client and stores nothing. URL-mode elicitation can later send the user to `/approvals/<id>` (no pre-authenticated URLs, which suits the session-gated page).
- **R8.** ECMA-402 takes currency digits from ISO 4217 — fine for display; stored amounts use a static table so a runtime data update never changes how `amount_minor` is read.
- **R2.** The IETF Idempotency-Key draft leaves storage policy to the server; common implementations namespace by caller and drop credential headers from replays. Tribo extends that to secret body fields.

## Daily retention job (after the trip; order matters)

1. Purge due file blobs: sensitive files at `end_date + document_retention_days`, deleted files at `deleted_at + document_retention_days`.
2. `audit.purge_trip_chain` for trips archived or deleted `audit_retention_days` ago (refuses while files await purge).
3. For deleted trips now retired, delete the trip's rows in one transaction, in FK order: allocations, tickets, expense shares, expenses, checklist entries, overlays, item shares, files, units, items, budget lines, invites, approvals, memberships, entity versions, the trip (destinations cascade); then placeholder persons left with no membership anywhere and their snapshots; then one platform audit event `purge`/`trip`.
4. `audit.purge_auth_chain` for months past retention.
5. Delete sessions 30 days after revoke or expiry, expired idempotency keys and OAuth rows, and trip-less approvals older than `audit_retention_days`.

No decisions are open.
