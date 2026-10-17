-- Tribo — 0001_init.sql
-- Source: "Tribo — Technical Design" (17 Oct 2026) incl. the accepted design review
-- and the 17 Oct gap fixes (reveal, person access, child visibility, consent,
-- operation-inventory decisions G1–G15). MCP on/off is deploy config (TRIBO_MCP_ENABLED),
-- not a column.
-- Revised 17 Oct after the schema review (claude/design/schema-review-2026-10-17.md):
-- R1–R41 below are referenced from that record.
-- Target: PostgreSQL 18+ (built-in uuidv7()). Run as tribo_owner, inside one
-- transaction, under the app's migration advisory lock.
--
-- THE RULE: every fact has exactly one owner, and only that owner stores, changes,
-- versions and enforces it. Nothing is copied, and nothing is enforced in two places.
-- What follows is that rule applied to each concern (R37–R41).
--
--   1. Records. Each row is one of four kinds:
--        root        has its own endpoints; carries version, created/updated/deleted_at/by;
--                    soft-deleted; one audit row + one entity_versions snapshot per write
--        owned       edited only through its root (allocations, item_shares, expense_shares,
--                    trip_destinations, budget_lines, mfa_recovery_codes): no version, no soft
--                    delete; replaced with the root and captured in the root's snapshot
--        credential  sessions, PATs, reset links, invites, OAuth rows: revoked or expired,
--                    never versioned or snapshotted
--        log         audit_events, entity_versions: append-only
--      Actor columns (created_by …) are omitted where one participant is the only possible
--      writer (overlays): they would copy the owner column.
--   2. Enforcement. The database declares what a single row or key can express (types,
--      domains, CHECK, FK, UNIQUE). Every rule that needs other rows, the caller or the clock
--      (permissions, visibility, lifecycle, share sums, capacity, currency lock) lives once,
--      in the service's single write path. The audit schema is its own owner: its triggers
--      protect the log (chaining, append-only, timestamps, retired chains) and only its
--      SECURITY DEFINER functions may delete from it.
--   3. People. Inside a trip, a person is their membership: anything they own, are shared,
--      are assigned, pay or keep private there references memberships. Outside a trip, a
--      person is their account: credentials, actor columns (created_by …, actor_user_id) and
--      personal library rows (templates.owner_id) reference users.
--   4. Derived state is computed, never stored: archived ⇔ archived_at, an approval is
--      expired ⇔ pending and past expires_at, sensitive ⇔ file kind, freshness of a read ⇔
--      SHA-256 ETag of the representation. There are no balances (R36).
--   5. Concurrency. One counter per aggregate; If-Match names it. Aggregates: every root
--      (version), an item's board (items.board_version) and a trip's budget
--      (trips.budget_version). Snapshot entity_type is the aggregate: item, item_board,
--      trip_budget, … Every write that could overwrite a change it hasn't seen carries
--      If-Match; one that replaces only a single value the caller alone owns (their RSVP)
--      cannot, so it bumps the counter without one. Credentials have no counter.
--   6. Idempotency-Key only on operations that create something; every other write is
--      naturally idempotent through If-Match or a one-way transition, except auth acts
--      and reveals, which are never replayed.
--
-- Conventions
--   * Ids: UUIDv7 (uuidv7()) stored as uuid; the API renders TypeID prefixes (trp_, itm_, evt_ ...).
--   * Partial unique indexes on roots ignore soft-deleted rows.
--   * Time: timestamptz + IANA tz per start/end; all-day items use date columns.
--   * Money: amount_minor bigint + ISO 4217 currency. Amounts in the trip currency
--     (shares, trip_amount_minor, planned_minor) carry no currency column; any other amount
--     carries its own. Minor-unit exponents come from a static ISO 4217 table shipped with
--     the app (never from the runtime's Intl/ICU data, which can change under stored amounts).
--   * Sensitive values: separate *_enc bytea columns (AES-256-GCM, app key), never in JSONB,
--     caches or idempotency storage. Envelope written by the app: key_version (1 byte) ‖
--     nonce ‖ ciphertext ‖ tag, with AAD = '<table>.<column>:<row id>' so a ciphertext copied
--     to another row fails to decrypt. Structured values are JSON-encoded before encryption.
--   * Closed value sets are text + CHECK rather than enums, so expand/contract
--     migrations can add or retire values without ALTER TYPE.
--   * No RLS (design review row 5): visibility is a service rule; tribo.item_visible() and
--     tribo.person_visible() are the shared SQL predicates the repository composes.

-- No BEGIN/COMMIT: the migration runner wraps this file and its schema_migrations row
-- in one transaction (packages/db/src/migrate.ts).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA tribo;
CREATE SCHEMA audit;

SET LOCAL search_path = tribo, public;

-- ---------------------------------------------------------------------------
-- Helpers and domains
-- ---------------------------------------------------------------------------

-- Marked IMMUTABLE so it can back a domain CHECK; the zone list only grows
-- with tzdata updates, which never invalidates stored values in practice.
-- STRICT: NULL in → NULL out, so nullable tz columns pass the domain CHECK.
-- R17: AT TIME ZONE alone also accepts abbreviations ('PST'), POSIX specs ('UTC+8',
-- 'EST5EDT,M3.2.0/2,M11.1.0') and bare offsets ('+08'), which are fixed-offset or
-- rule-less. The shape check limits input to Area/Location names (plus 'UTC'),
-- which PostgreSQL resolves only through the tz database.
CREATE FUNCTION tribo.is_valid_tz(tz text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF tz !~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$' THEN
    RETURN false;
  END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END $$;

CREATE DOMAIN tribo.iana_tz   AS text    CHECK (tribo.is_valid_tz(VALUE));
CREATE DOMAIN tribo.currency  AS char(3) CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN tribo.username  AS citext  CHECK (VALUE ~ '^[A-Za-z0-9._-]{3,32}$');
CREATE DOMAIN tribo.sha256    AS bytea   CHECK (octet_length(VALUE) = 32);

-- ---------------------------------------------------------------------------
-- Identity: accounts, credentials, sessions, tokens
-- ---------------------------------------------------------------------------

CREATE TABLE tribo.users (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  username           tribo.username NOT NULL,
  password_hash      text NOT NULL,                 -- Argon2id PHC string; '!' = no password (erased)
  mfa_secret_enc     bytea,                         -- TOTP secret, encrypted
  mfa_enabled_at     timestamptz,
  platform_role      text NOT NULL DEFAULT 'user'   CHECK (platform_role IN ('admin', 'user')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count int  NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  last_login_at      timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES tribo.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES tribo.users (id),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES tribo.users (id),
  CONSTRAINT users_admin_needs_mfa CHECK (platform_role <> 'admin' OR mfa_enabled_at IS NOT NULL OR status = 'disabled'),
  CONSTRAINT users_mfa_has_secret CHECK (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_key ON tribo.users (username) WHERE deleted_at IS NULL;
COMMENT ON TABLE tribo.users IS 'Local accounts only: no email, no external IdP. Created via invite link or admin CLI.';
COMMENT ON CONSTRAINT users_admin_needs_mfa ON tribo.users IS
  'Bootstrap: `tribo admin create` inserts the admin as disabled, enrols TOTP, then activates. '
  'R3: admin.users.mfaReset on an active admin sets status = disabled in the same write; the '
  'admin re-enrols via a reset link and another admin (or the CLI) reactivates.';

CREATE TABLE tribo.mfa_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id   uuid NOT NULL REFERENCES tribo.users (id) ON DELETE CASCADE,
  code_hash text NOT NULL,                          -- Argon2id of the code
  used_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON tribo.mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE tribo.password_reset_links (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES tribo.users (id) ON DELETE CASCADE,
  token_hash  tribo.sha256 NOT NULL UNIQUE,         -- SHA-256 of a 256-bit token, shown once
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES tribo.users (id)
);
CREATE INDEX password_reset_links_user_idx ON tribo.password_reset_links (user_id);

CREATE TABLE tribo.sessions (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid NOT NULL REFERENCES tribo.users (id) ON DELETE CASCADE,
  token_hash          tribo.sha256 NOT NULL UNIQUE, -- __Host- cookie value, hashed
  mfa_verified_at     timestamptz,
  step_up_at          timestamptz,                  -- slice 1b: last fresh password/TOTP; break-glass reads accepted for 10 min
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days',
  absolute_expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at          timestamptz,
  ip                  inet,                         -- client IP as resolved by the proxy's trusted-proxy rules
  user_agent          text
);
CREATE INDEX sessions_user_idx ON tribo.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON tribo.sessions (absolute_expires_at);
COMMENT ON TABLE tribo.sessions IS
  'R34: the daily job deletes a session 30 days after it was revoked or expired (idle or absolute), '
  'so ip and user_agent follow the same short retention as the request logs.';

-- Slice 1b (personal access tokens).
CREATE TABLE tribo.personal_access_tokens (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES tribo.users (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_prefix text NOT NULL,                       -- e.g. 'tribo_pat_3fk2' for display
  token_hash   tribo.sha256 NOT NULL UNIQUE,
  scope        text NOT NULL CHECK (scope IN ('read', 'write')),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pat_max_one_year CHECK (expires_at <= created_at + interval '1 year')
);
CREATE INDEX personal_access_tokens_user_idx ON tribo.personal_access_tokens (user_id) WHERE revoked_at IS NULL;

-- node-oidc-provider adapter storage (OAuth 2.1 for MCP only, slice 1b). One table for
-- all models; the adapter stores token-bearing models (AccessToken,
-- RefreshToken, AuthorizationCode) under a SHA-256 of their id.
CREATE TABLE tribo.oauth_store (
  model       text NOT NULL,                        -- AccessToken, RefreshToken, Grant, Interaction, Session, ...
  id          text NOT NULL,
  payload     jsonb NOT NULL,
  grant_id    text,
  uid         text,
  user_code   text,
  expires_at  timestamptz,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, id)
);
CREATE INDEX oauth_store_grant_idx   ON tribo.oauth_store (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX oauth_store_uid_idx     ON tribo.oauth_store (uid) WHERE uid IS NOT NULL;
CREATE INDEX oauth_store_expires_idx ON tribo.oauth_store (expires_at);

-- Allowlist of MCP clients, keyed by their Client ID Metadata Document URL.
-- Slice 1b (MCP client allowlist).
CREATE TABLE tribo.mcp_clients (
  client_id     text PRIMARY KEY CHECK (client_id ~ '^https://'),
  display_name  text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  metadata      jsonb,                              -- last fetched CIMD
  metadata_fetched_at timestamptz,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES tribo.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES tribo.users (id),
  deleted_at    timestamptz,                        -- admin.clients.remove (R38: roots soft-delete)
  deleted_by    uuid REFERENCES tribo.users (id)
);

-- Single-row platform settings (a root without created_*/deleted_*: it always exists).
CREATE TABLE tribo.platform_settings (
  singleton               boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  document_retention_days int NOT NULL DEFAULT 30  CHECK (document_retention_days BETWEEN 0 AND 3650),
  audit_retention_days    int NOT NULL DEFAULT 730 CHECK (audit_retention_days BETWEEN 30 AND 36500),
  version                 int NOT NULL DEFAULT 1,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES tribo.users (id),
  -- R29: files are purged before the trip's audit chain can retire, so file retention
  -- must not outlast audit retention.
  CONSTRAINT settings_retention_order CHECK (document_retention_days <= audit_retention_days)
);
INSERT INTO tribo.platform_settings DEFAULT VALUES;

-- ---------------------------------------------------------------------------
-- Library: people, places, vendors, templates
-- ---------------------------------------------------------------------------
-- Places, vendors and shared templates are one library visible to every account.
-- People are NOT: a person row is visible only per tribo.person_visible().

CREATE TABLE tribo.persons (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid UNIQUE REFERENCES tribo.users (id),   -- null = placeholder traveler, forever (R28)
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  contacts           jsonb NOT NULL DEFAULT '{}',   -- {phone, messenger, ...}
  dietary            text,
  emergency_contact_enc bytea,                      -- R5: {name, relation, phone} JSON, encrypted; masked, reveal
  driving_licence    boolean NOT NULL DEFAULT false,
  id_doc_enc         bytea,                         -- slice 1b: government ID number, encrypted
  passport_enc       bytea,                         -- slice 1b: passport no. + expiry, encrypted
  consent_recorded_at timestamptz,                  -- slice 1b: organizer confirmed consent to store ID (RA 10173)
  erased_at          timestamptz,                   -- RA 10173 erasure: PII scrubbed, row kept as tombstone
  merged_into        uuid REFERENCES tribo.persons (id),  -- R28: set when a placeholder's last membership was claimed
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES tribo.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES tribo.users (id),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES tribo.users (id),
  CONSTRAINT persons_id_needs_consent CHECK (
    (id_doc_enc IS NULL AND passport_enc IS NULL) OR consent_recorded_at IS NOT NULL),
  CONSTRAINT persons_erased_scrubbed CHECK (erased_at IS NULL OR (
    display_name = 'Erased traveller' AND NOT driving_licence
    AND id_doc_enc IS NULL AND passport_enc IS NULL AND emergency_contact_enc IS NULL
    AND dietary IS NULL AND contacts = '{}')),
  CONSTRAINT persons_merged_scrubbed CHECK (merged_into IS NULL OR (
    merged_into <> id AND deleted_at IS NOT NULL AND user_id IS NULL
    AND id_doc_enc IS NULL AND passport_enc IS NULL AND emergency_contact_enc IS NULL
    AND dietary IS NULL AND contacts = '{}'))
);
COMMENT ON COLUMN tribo.persons.erased_at IS
  'R20 erasure (admin.people.erase) scrubs PII here and in the person''s tickets, deletes their '
  'entity_versions snapshots and overlays, and anonymises the linked account, but keeps this row '
  'and its memberships so other members'' expenses and shares stay correct. Free text '
  'written by others (expense descriptions, notes) is not scanned. R32: refused with '
  'owner_transfer_required while the person owns a trip that is not deleted.';
COMMENT ON COLUMN tribo.persons.merged_into IS
  'R28: claims are per trip. Accepting a placeholder invite moves only that trip''s membership from '
  'the placeholder to the caller''s own person (created at sign-up for a new account); the '
  'placeholder never gains a user_id, so a claim can never reach another trip. When the placeholder '
  'has no membership rows left anywhere, it is scrubbed, soft-deleted and pointed here; old ids '
  'resolve to the survivor.';
COMMENT ON CONSTRAINT persons_id_needs_consent ON tribo.persons IS
  'ID and passport values (slice 1b) can be stored only after consent is recorded.';
CREATE INDEX persons_name_trgm ON tribo.persons USING gin (display_name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX persons_created_by_idx ON tribo.persons (created_by) WHERE deleted_at IS NULL;
COMMENT ON COLUMN tribo.persons.user_id IS
  'Set once, when an account is created: every account has exactly one person (created_by = the '
  'account) and edits it via me.update. Placeholders keep user_id null and are edited by their '
  'creator; R19''s creator clause in person_visible therefore only ever applies to placeholders.';

CREATE TABLE tribo.places (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind       text NOT NULL DEFAULT 'other'
             CHECK (kind IN ('destination', 'beach', 'landmark', 'port', 'airport', 'lodging', 'restaurant', 'other')),
  lat        numeric(9, 6) CHECK (lat BETWEEN -90 AND 90),
  lng        numeric(9, 6) CHECK (lng BETWEEN -180 AND 180),
  address    text,
  hours      jsonb,                                 -- opening hours (rule check deferred)
  links      jsonb NOT NULL DEFAULT '[]',
  notes      text,
  merged_into uuid REFERENCES tribo.places (id),     -- set by admin merge (1b); old id resolves to the survivor
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES tribo.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES tribo.users (id),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES tribo.users (id),
  CONSTRAINT places_merged_deleted CHECK (merged_into IS NULL OR (deleted_at IS NOT NULL AND merged_into <> id)),
  CONSTRAINT places_latlng_pair CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX places_name_trgm ON tribo.places USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
COMMENT ON COLUMN tribo.places.merged_into IS
  'Merge repoints rows already merged into the loser to the survivor, so chains stay one hop.';

CREATE TABLE tribo.vendors (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind       text NOT NULL DEFAULT 'other'
             CHECK (kind IN ('airline', 'lodging', 'tour_operator', 'rental', 'ferry_line', 'bus_line', 'restaurant', 'other')),
  place_id   uuid REFERENCES tribo.places (id),
  contacts   jsonb NOT NULL DEFAULT '{}',
  links      jsonb NOT NULL DEFAULT '[]',          -- e.g. Facebook page
  notes      text,
  merged_into uuid REFERENCES tribo.vendors (id),    -- set by admin merge (1b); one hop, as places
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES tribo.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES tribo.users (id),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES tribo.users (id),
  CONSTRAINT vendors_merged_deleted CHECK (merged_into IS NULL OR (deleted_at IS NOT NULL AND merged_into <> id))
);
CREATE INDEX vendors_name_trgm ON tribo.vendors USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;

-- Slice 1b (templates).
CREATE TABLE tribo.templates (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id   uuid REFERENCES tribo.users (id),     -- null = shared (published by admin)
  kind       text NOT NULL CHECK (kind IN ('trip', 'packing', 'checklist', 'budget')),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  body       jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),  -- Zod schema per kind
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES tribo.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES tribo.users (id),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES tribo.users (id)
);
CREATE INDEX templates_owner_idx ON tribo.templates (owner_id, kind) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Trips and membership
-- ---------------------------------------------------------------------------

CREATE TABLE tribo.trips (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  currency        tribo.currency NOT NULL,          -- R9: service refuses changes once money is recorded
  timezone        tribo.iana_tz NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'planning', 'active', 'completed')),
  archived_at     timestamptz,                      -- R40: archived ⇔ not null (no 'archived' status)
  audit_retired_at timestamptz,                     -- R29: set by audit.purge_trip_chain; trip frozen after
  cloned_from     uuid REFERENCES tribo.trips (id),
  version         int NOT NULL DEFAULT 1,
  budget_version  int NOT NULL DEFAULT 1 CHECK (budget_version >= 1),  -- R35: counter of the trip_budget aggregate
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES tribo.users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES tribo.users (id),
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES tribo.users (id),
  CONSTRAINT trips_dates CHECK (end_date >= start_date),
  CONSTRAINT trips_archived_completed CHECK (archived_at IS NULL OR status = 'completed'),
  CONSTRAINT trips_retired_after_close CHECK (
    audit_retired_at IS NULL OR archived_at IS NOT NULL OR deleted_at IS NOT NULL)
);
COMMENT ON COLUMN tribo.trips.status IS
  'Transitions draft → planning → active → completed enforced in service (trips.update). '
  'trips.archive (owner, from completed) sets archived_at, one-way; the API renders status '
  '"archived" from it. R29: an archived trip is read-only: every write under it returns '
  'trip_archived, except trips.delete and trips.restore.';
COMMENT ON COLUMN tribo.trips.audit_retired_at IS
  'R29: once the trip''s audit chain is retired, audit.chain_event rejects any new trip-scoped event, '
  'and since every write under a trip appends one in the same transaction, the trip is frozen in '
  'the database itself (including delete and restore). A deleted trip''s rows are then removed by '
  'the service''s retention purge (R34); an archived one stays readable.';
COMMENT ON TABLE tribo.trips IS
  'Owner = the active membership with trip_role owner. Reads carry a SHA-256 ETag of the '
  'per-caller representation (R12, R40): dashboard and offline bundle polls use If-None-Match, so '
  'library edits and per-caller visibility are always reflected. There is no contentVersion.';

CREATE TABLE tribo.trip_destinations (
  trip_id  uuid NOT NULL REFERENCES tribo.trips (id) ON DELETE CASCADE,
  place_id uuid NOT NULL REFERENCES tribo.places (id),
  position int  NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, place_id)
);

CREATE TABLE tribo.memberships (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id        uuid NOT NULL REFERENCES tribo.trips (id),
  person_id      uuid NOT NULL REFERENCES tribo.persons (id),  -- account via persons.user_id
  trip_role      text NOT NULL CHECK (trip_role IN ('owner', 'organizer', 'member', 'viewer')),
  can_view_costs boolean NOT NULL DEFAULT false,   -- only meaningful for viewers
  version        int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES tribo.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES tribo.users (id),
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES tribo.users (id),
  UNIQUE (id, trip_id),                             -- target for same-trip composite FKs
  UNIQUE (trip_id, person_id)                       -- R22/R28: one row per person per trip, ever
);
CREATE UNIQUE INDEX memberships_one_owner       ON tribo.memberships (trip_id)
  WHERE deleted_at IS NULL AND trip_role = 'owner';
COMMENT ON INDEX tribo.memberships_one_owner IS
  'Owner transfer (members.setRole) demotes the current owner to organizer first, then promotes '
  'the new owner, in one transaction. The owner is always a person with an account.';
CREATE INDEX memberships_person_idx ON tribo.memberships (person_id) WHERE deleted_at IS NULL;
COMMENT ON TABLE tribo.memberships IS
  'No status column: people join only through invite links (no pending invites), a placeholder is '
  'a person with no user_id, and removal is the soft delete. members.add only takes persons without '
  'an account (R4). (trip_id, person_id) is unique across all rows, so rejoining or re-adding '
  'undeletes the earlier membership and ledger rows keep one membership id. A placeholder claim '
  'fails with claim_conflict when the caller''s person already has a row in the trip. '
  'R32: removal, in the same request, deletes the member''s allocations (bumping each item''s '
  'board_version) and soft-deletes the private items they own, which nobody else could see; '
  'rejoining undeletes those items via the removal''s request_id.';

CREATE TABLE tribo.invites (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id     uuid NOT NULL REFERENCES tribo.trips (id),
  token_hash  tribo.sha256 NOT NULL UNIQUE,         -- link is /join#<token> (fragment: never in proxy logs), token shown once
  role        text NOT NULL CHECK (role IN ('organizer', 'member', 'viewer')),
  person_id   uuid,                                 -- optional pre-link to a placeholder to claim
  expires_at  timestamptz NOT NULL,
  max_uses    int CHECK (max_uses > 0),             -- null = unlimited until expiry
  uses        int NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES tribo.users (id),
  CONSTRAINT invites_uses_cap CHECK (max_uses IS NULL OR uses <= max_uses),
  CONSTRAINT invites_placeholder_single_use CHECK (person_id IS NULL OR max_uses = 1),
  -- R28: the pre-linked placeholder must have a membership in THIS trip. On accept the
  -- membership moves to the claimer and person_id follows it, recording who claimed.
  FOREIGN KEY (trip_id, person_id) REFERENCES tribo.memberships (trip_id, person_id) ON UPDATE CASCADE
);
CREATE INDEX invites_trip_idx ON tribo.invites (trip_id);
COMMENT ON COLUMN tribo.invites.person_id IS
  'The FK guarantees the person has a membership row in the invite''s trip; create and accept also '
  'check it is active and still a placeholder (user_id null), else invite_invalid.';

-- Slice 1b (budget vs actual).
CREATE TABLE tribo.budget_lines (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id       uuid NOT NULL REFERENCES tribo.trips (id),
  category      text NOT NULL CHECK (category ~ '^[a-z0-9_]{1,40}$'),  -- airfare, lodging, e_bikes, food, fees
  label         text NOT NULL,
  planned_minor bigint NOT NULL DEFAULT 0 CHECK (planned_minor >= 0),
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES tribo.users (id),
  UNIQUE (trip_id, category)
);
COMMENT ON COLUMN tribo.budget_lines.planned_minor IS 'In the trip currency.';
COMMENT ON TABLE tribo.budget_lines IS
  'Owned rows of the trip_budget aggregate (R38). budget.replace locks the trip row, checks '
  'If-Match against trips.budget_version, deletes and re-inserts the lines, bumps the counter and '
  'writes one audit row and one trip_budget snapshot.';

-- ---------------------------------------------------------------------------
-- Items (polymorphic) and their relational children
-- ---------------------------------------------------------------------------

CREATE TABLE tribo.items (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id             uuid NOT NULL REFERENCES tribo.trips (id),
  type                text NOT NULL
                      CHECK (type IN ('transport', 'lodging', 'ground', 'activity', 'meal', 'task', 'note', 'document')),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  status              text NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('draft', 'planned', 'booked', 'confirmed', 'open', 'done', 'cancelled')),
  -- timed items
  start_at            timestamptz,
  start_tz            tribo.iana_tz,
  end_at              timestamptz,
  end_tz              tribo.iana_tz,
  -- all-day items
  start_date          date,
  end_date            date,
  place_id            uuid REFERENCES tribo.places (id),
  vendor_id           uuid REFERENCES tribo.vendors (id),
  cost_minor          bigint CHECK (cost_minor >= 0),  -- booked price; who paid lives in expenses.item_id
  cost_currency       tribo.currency,
  visibility          text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private', 'selected')),
  owner_membership_id uuid NOT NULL,                -- R39: participants are memberships
  tags                text[] NOT NULL DEFAULT '{}',
  restricted_fields   text[] NOT NULL DEFAULT '{}', -- per-item tightening of field masking
  details             jsonb NOT NULL DEFAULT '{}',  -- typed per `type` (Zod, versioned with the API)
  booking_ref_enc     bytea,
  card_last4_enc      bytea,
  version             int NOT NULL DEFAULT 1,
  board_version       int NOT NULL DEFAULT 1 CHECK (board_version >= 1),  -- R26: assignment board + RSVPs
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES tribo.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES tribo.users (id),
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES tribo.users (id),
  UNIQUE (id, trip_id),
  FOREIGN KEY (owner_membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id),
  CONSTRAINT items_start_tz  CHECK ((start_at IS NULL) = (start_tz IS NULL)),
  CONSTRAINT items_end_tz    CHECK ((end_at IS NULL) = (end_tz IS NULL)),
  -- R16: timed and all-day fields never mix, and an end needs a start.
  CONSTRAINT items_timed_or_allday CHECK (
    (start_at IS NULL AND end_at IS NULL) OR (start_date IS NULL AND end_date IS NULL)),
  CONSTRAINT items_end_needs_start CHECK (
    (end_at IS NULL OR start_at IS NOT NULL) AND (end_date IS NULL OR start_date IS NOT NULL)),
  CONSTRAINT items_time_order CHECK (end_at IS NULL OR end_at >= start_at),
  CONSTRAINT items_date_order CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT items_cost_currency CHECK ((cost_minor IS NULL) = (cost_currency IS NULL)),
  CONSTRAINT items_details_object CHECK (jsonb_typeof(details) = 'object')
);
COMMENT ON COLUMN tribo.items.version IS
  'Item fields only (items.update If-Match). Board saves and RSVPs bump board_version instead, so '
  'collecting RSVPs never fails a concurrent item edit with 412.';
COMMENT ON COLUMN tribo.items.board_version IS
  'Assignment board + RSVPs. ETag of items.assignments.get/replace; snapshot in entity_versions as '
  'entity_type item_board at this version. items.history interleaves both series by time.';
CREATE INDEX items_trip_timeline_idx ON tribo.items (trip_id, start_at, start_date) WHERE deleted_at IS NULL;
CREATE INDEX items_trip_type_idx     ON tribo.items (trip_id, type) WHERE deleted_at IS NULL;
CREATE INDEX items_owner_private_idx ON tribo.items (owner_membership_id) WHERE deleted_at IS NULL AND visibility <> 'shared';
CREATE INDEX items_place_idx         ON tribo.items (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX items_vendor_idx        ON tribo.items (vendor_id) WHERE vendor_id IS NOT NULL;

CREATE TABLE tribo.item_shares (
  item_id       uuid NOT NULL,
  trip_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES tribo.users (id),
  PRIMARY KEY (item_id, membership_id),
  FOREIGN KEY (item_id, trip_id)       REFERENCES tribo.items (id, trip_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id)
);
CREATE INDEX item_shares_membership_idx ON tribo.item_shares (membership_id);
COMMENT ON TABLE tribo.item_shares IS
  'Owned rows of the item (written by items.update sharedWith): the memberships that can see an '
  'item with visibility = selected.';

CREATE TABLE tribo.units (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  item_id     uuid NOT NULL REFERENCES tribo.items (id),
  kind        text NOT NULL CHECK (kind IN ('room', 'vehicle')),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  capacity    int  NOT NULL CHECK (capacity BETWEEN 1 AND 100),  -- vehicles: seats incl. driver
  bed_type    text,
  rate_minor  bigint CHECK (rate_minor >= 0),       -- nightly (room) or per-day (vehicle)
  rate_currency tribo.currency,
  position    int NOT NULL DEFAULT 0,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES tribo.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES tribo.users (id),
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES tribo.users (id),
  UNIQUE (id, item_id),
  CONSTRAINT units_rate_currency CHECK ((rate_minor IS NULL) = (rate_currency IS NULL))
);
CREATE INDEX units_item_idx ON tribo.units (item_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX units_item_label_key ON tribo.units (item_id, label) WHERE deleted_at IS NULL;

-- The assignment board of an item: RSVPs, room occupants, vehicle drivers and
-- passengers, flight/ferry passengers and task assignees, so "My trip" and
-- itinerary view=me read one table.
-- Saved whole by owners and organizers: PUT /v1/items/{id}/assignments with If-Match
-- on the item's board_version. The service locks the item row and its unit rows FOR
-- UPDATE, checks capacity on the final state (so two people can swap between full
-- rooms), deletes and re-inserts the rows, bumps items.board_version and writes one
-- audit event. A member's own RSVP is PUT /v1/items/{id}/rsvp: same lock and
-- board_version bump, touching only the caller's attendee row, with no If-Match
-- (last write wins on one's own answer). Rows carry no version or soft delete:
-- history and restore come from the item_board snapshot.
-- Units are soft-deleted, so nothing cascades: units.delete and members.remove delete
-- the affected rows themselves (R21). A board restore drops rows whose unit is deleted.
CREATE TABLE tribo.allocations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id       uuid NOT NULL,
  item_id       uuid NOT NULL,
  unit_id       uuid,                               -- room or vehicle; null for flights, ferries, tasks
  membership_id uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('attendee', 'occupant', 'driver', 'passenger', 'assignee')),
  rsvp          text CHECK (rsvp IN ('pending', 'yes', 'no', 'maybe')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES tribo.users (id),
  FOREIGN KEY (item_id, trip_id)       REFERENCES tribo.items (id, trip_id),
  FOREIGN KEY (membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id),
  FOREIGN KEY (unit_id, item_id)       REFERENCES tribo.units (id, item_id),
  CONSTRAINT allocations_unit_roles CHECK (
    CASE role WHEN 'occupant'  THEN unit_id IS NOT NULL
              WHEN 'driver'    THEN unit_id IS NOT NULL
              WHEN 'passenger' THEN true      -- vehicle seat, or none on a flight/ferry
              ELSE unit_id IS NULL END),
  CONSTRAINT allocations_rsvp_attendee CHECK (rsvp IS NULL OR role = 'attendee')
);
-- A member holds at most one seat or room per item, and one row per non-unit role.
CREATE UNIQUE INDEX allocations_one_unit_per_member ON tribo.allocations (item_id, membership_id)
  WHERE role IN ('occupant', 'driver', 'passenger');
CREATE UNIQUE INDEX allocations_one_role_per_member ON tribo.allocations (item_id, membership_id, role)
  WHERE role IN ('attendee', 'assignee');
-- At most one driver per vehicle.
CREATE UNIQUE INDEX allocations_one_driver_per_unit ON tribo.allocations (unit_id) WHERE role = 'driver';
CREATE INDEX allocations_unit_idx       ON tribo.allocations (unit_id);
CREATE INDEX allocations_membership_idx ON tribo.allocations (membership_id, role);

-- Per-passenger ticket on a transport item, edited on its own (/v1/items/{id}/tickets)
-- so saving the assignment board never touches ticket numbers.
CREATE TABLE tribo.tickets (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id       uuid NOT NULL,
  item_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  seat          text,
  ticket_no_enc bytea,
  baggage       jsonb NOT NULL DEFAULT '{}',        -- {checked_kg, cabin_kg, add_ons: [...]}
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES tribo.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES tribo.users (id),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES tribo.users (id),
  FOREIGN KEY (item_id, trip_id)       REFERENCES tribo.items (id, trip_id),
  FOREIGN KEY (membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id)
);
CREATE UNIQUE INDEX tickets_item_member_key ON tribo.tickets (item_id, membership_id) WHERE deleted_at IS NULL;
CREATE INDEX tickets_membership_idx ON tribo.tickets (membership_id) WHERE deleted_at IS NULL;

-- Slice 1b (shared checklist entries).
CREATE TABLE tribo.checklist_entries (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  item_id    uuid NOT NULL REFERENCES tribo.items (id),
  position   int  NOT NULL,
  text       text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  done_by    uuid REFERENCES tribo.users (id),
  done_at    timestamptz,
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES tribo.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES tribo.users (id),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES tribo.users (id),
  CONSTRAINT checklist_done_pair CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX checklist_entries_item_idx ON tribo.checklist_entries (item_id, position) WHERE deleted_at IS NULL;

-- Personal overlay on a (usually shared) item; always private to its membership.
-- reminder_at feeds the in-app "Due soon" list (dashboard, /v1/me/tasks) in 1a; push in release 2.
-- No actor columns: the membership is the only possible writer (rule 1).
CREATE TABLE tribo.overlays (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id       uuid NOT NULL,
  item_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  note          text,
  reminder_at   timestamptz,
  checklist     jsonb NOT NULL DEFAULT '[]',
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  FOREIGN KEY (item_id, trip_id)       REFERENCES tribo.items (id, trip_id),
  FOREIGN KEY (membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id)
);
CREATE UNIQUE INDEX overlays_item_member_key ON tribo.overlays (item_id, membership_id) WHERE deleted_at IS NULL;
CREATE INDEX overlays_reminder_idx ON tribo.overlays (membership_id, reminder_at) WHERE deleted_at IS NULL AND reminder_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Money: expenses and their member splits (record only, R36)
-- ---------------------------------------------------------------------------
-- Expenses are the trip's shared ledger: every member sees them (costs masked for
-- viewers without can_view_costs), even when linked to a private item. In that case
-- the serializer nulls item_id for callers who cannot see the item.
-- R36: Tribo records what was spent and how each expense is split among the members
-- included in it. It never computes who owes whom, suggests transfers or tracks
-- payments: there are no debts, balances or settle-up. payer_membership_id is a fact
-- about the expense, not the input to any netting.

CREATE TABLE tribo.expenses (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id             uuid NOT NULL REFERENCES tribo.trips (id),
  item_id             uuid,
  category            text NOT NULL CHECK (category ~ '^[a-z0-9_]{1,40}$'),
  description         text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  spent_on            date NOT NULL,
  payer_membership_id uuid NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),  -- original currency
  currency            tribo.currency NOT NULL,
  fx_rate             numeric(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),  -- trip-currency major units per 1 original major unit
  fx_date             date,
  fx_source           text,                         -- 'manual' in MVP
  trip_amount_minor   bigint NOT NULL CHECK (trip_amount_minor > 0),         -- frozen at write
  split_method        text NOT NULL CHECK (split_method IN ('equal', 'weight', 'itemised')),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES tribo.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES tribo.users (id),
  deleted_at          timestamptz,                  -- void = soft delete, audited
  deleted_by          uuid REFERENCES tribo.users (id),
  UNIQUE (id, trip_id),
  FOREIGN KEY (item_id, trip_id)             REFERENCES tribo.items (id, trip_id),
  FOREIGN KEY (payer_membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id)
);
COMMENT ON COLUMN tribo.expenses.trip_amount_minor IS
  'R8: max(1, round_half_up(amount_minor × fx_rate × 10^(e_trip − e_orig))), e = ISO 4217 '
  'minor-unit exponent of each currency (JPY 0, PHP 2, KWD 3). Same currency: fx_rate = 1.';
CREATE INDEX expenses_trip_idx  ON tribo.expenses (trip_id, spent_on) WHERE deleted_at IS NULL;
CREATE INDEX expenses_payer_idx ON tribo.expenses (payer_membership_id) WHERE deleted_at IS NULL;
CREATE INDEX expenses_item_idx  ON tribo.expenses (item_id) WHERE deleted_at IS NULL AND item_id IS NOT NULL;

-- Owned rows of the expense: one per member included in it (the payer is included only
-- if they share in it). Frozen at write time per split_method: equal, weight (weight
-- column) or itemised (explicit amounts); largest-remainder rounding. The write path
-- guarantees sum(share_minor) = trip_amount_minor (R11, rule 2).
CREATE TABLE tribo.expense_shares (
  expense_id    uuid NOT NULL,
  trip_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  share_minor   bigint NOT NULL CHECK (share_minor >= 0),   -- trip currency
  weight        numeric(10, 4) CHECK (weight > 0),         -- for split_method = weight
  PRIMARY KEY (expense_id, membership_id),
  FOREIGN KEY (expense_id, trip_id)    REFERENCES tribo.expenses (id, trip_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id)
);
CREATE INDEX expense_shares_membership_idx ON tribo.expense_shares (membership_id);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE tribo.files (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id     uuid NOT NULL REFERENCES tribo.trips (id),
  item_id     uuid,
  owner_membership_id uuid NOT NULL,                -- R39
  kind        text NOT NULL CHECK (kind IN ('id', 'ticket', 'voucher', 'photo', 'other')),
  sensitive   boolean GENERATED ALWAYS AS (kind IN ('id', 'ticket', 'voucher')) STORED,
  visibility  text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  filename    text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type   text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp')),
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),  -- 25 MB hard ceiling
  blob_key    text NOT NULL UNIQUE,                 -- path on the upload volume (ciphertext)
  sha256      tribo.sha256 NOT NULL,                -- of the plaintext
  enc_key_version smallint NOT NULL DEFAULT 1,      -- app key that encrypted the blob (offline rotation)
  purged_at   timestamptz,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES tribo.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES tribo.users (id),
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES tribo.users (id),
  FOREIGN KEY (item_id, trip_id) REFERENCES tribo.items (id, trip_id),
  FOREIGN KEY (owner_membership_id, trip_id) REFERENCES tribo.memberships (id, trip_id),
  CONSTRAINT files_purged_tombstone CHECK (purged_at IS NULL OR filename = 'purged')
);
CREATE INDEX files_trip_idx  ON tribo.files (trip_id) WHERE deleted_at IS NULL AND purged_at IS NULL;
CREATE INDEX files_item_idx  ON tribo.files (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX files_purge_due_idx ON tribo.files (trip_id) WHERE sensitive AND purged_at IS NULL;
CREATE INDEX files_deleted_purge_idx ON tribo.files (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
COMMENT ON TABLE tribo.files IS
  'Retention (daily job, no stored purge date): a sensitive file is due when trips.end_date + '
  'platform_settings.document_retention_days < current_date; any soft-deleted file (or file of a '
  'soft-deleted trip) is due document_retention_days after its deleted_at. Purge deletes the blob '
  'and replaces filename with ''purged'' (content-free tombstone). '
  'Visible to members when shared, to the owner membership when private, AND, if item_id is set, '
  'when tribo.item_visible() holds for the parent: a shared file on a private item stays private.';

-- ---------------------------------------------------------------------------
-- Versioning, approvals, idempotency
-- ---------------------------------------------------------------------------

-- One full snapshot per write; source for history diffs (computed and masked at
-- read time) and for restore. Ciphertext stays ciphertext. Erasure and retention
-- delete rows here; audit rows never hold field values. One series per aggregate (rule 5):
-- entity_type is the aggregate ('item', 'item_board', 'trip_budget', 'expense', …) and
-- version is that aggregate's counter; owned rows appear only inside their root's snapshot.
CREATE TABLE tribo.entity_versions (
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  version     int  NOT NULL CHECK (version >= 1),
  trip_id     uuid,                                 -- for trip-level purge; no FK (outlives soft-deleted trips)
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, version)
);
CREATE INDEX entity_versions_trip_idx ON tribo.entity_versions (trip_id) WHERE trip_id IS NOT NULL;

-- Slice 1b (MCP approvals).
CREATE TABLE tribo.approvals (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  trip_id            uuid REFERENCES tribo.trips (id),
  requested_by       uuid NOT NULL REFERENCES tribo.users (id),
  client_id          text NOT NULL,                 -- CIMD URL of the MCP client
  client_name        text,
  operation_id       text NOT NULL,                 -- e.g. items.delete
  input              jsonb NOT NULL,                -- ids and field paths only; never plaintext secrets
  target_entity_type text,
  target_entity_id   uuid,
  target_version     int,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  decided_by         uuid REFERENCES tribo.users (id),
  decided_at         timestamptz,
  reason             text,
  failure_code       text,                          -- e.g. version_conflict when status = failed
  consumed_at        timestamptz,                   -- R15: reveal approvals, claimed once by the requesting client
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  CONSTRAINT approvals_decision CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT approvals_decider CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT approvals_failed_code CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT approvals_consumed CHECK (consumed_at IS NULL OR status = 'approved')
);
CREATE INDEX approvals_pending_idx ON tribo.approvals (trip_id, expires_at) WHERE status = 'pending';
CREATE INDEX approvals_requester_idx ON tribo.approvals (requested_by, created_at);
COMMENT ON COLUMN tribo.approvals.status IS
  'R40: "expired" is derived, never stored: a pending approval past expires_at is shown as expired '
  'and cannot be decided (approval_not_pending).';
COMMENT ON COLUMN tribo.approvals.consumed_at IS
  'Writes (delete, role change) re-run at approve time. Reveals cannot: the plaintext must reach the '
  'MCP client and is never stored. The client calls reveal_fields again with approvalId; the server '
  'checks requester, client_id and input match, decided_at within 10 minutes and consumed_at null, '
  'sets consumed_at, audits the reveal and returns the values.';

CREATE TABLE tribo.idempotency_keys (
  caller          text NOT NULL,                    -- 'user:<id>', 'pat:<id>', 'oauth:<client>:<user>', 'invite:<invite id>' (anonymous accept)
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  operation_id    text NOT NULL,
  request_hash    tribo.sha256 NOT NULL,
  response_status int,                              -- null while the first request is in flight
  response_body   jsonb,                            -- secret fields stripped before storing (R2)
  response_redacted boolean NOT NULL DEFAULT false, -- replay then omits them and says so
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (caller, key)
);
CREATE INDEX idempotency_keys_expires_idx ON tribo.idempotency_keys (expires_at);
COMMENT ON TABLE tribo.idempotency_keys IS
  'R2: fields marked secret in the Zod response schemas (PAT and invite tokens, set-password and '
  'reset links, recovery codes) are never stored; Set-Cookie is never replayed. A replay returns the '
  'stored body without them and response_redacted = true, so the client revokes and recreates. '
  'Only operations that create something take an Idempotency-Key (rule 6); auth acts and reveals '
  'are never replayed.';

-- ---------------------------------------------------------------------------
-- Visibility building blocks used by the repository predicates
-- ---------------------------------------------------------------------------

-- R18: a soft-deleted trip has no members for visibility purposes.
CREATE FUNCTION tribo.is_member(uid uuid, trip uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tribo.memberships m
      JOIN tribo.persons p ON p.id = m.person_id
      JOIN tribo.trips t ON t.id = m.trip_id
     WHERE m.trip_id = trip AND p.user_id = uid
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL)
$$;
COMMENT ON FUNCTION tribo.is_member(uuid, uuid) IS
  'trips.restore is the one caller that must look past trips.deleted_at: it checks the owner '
  'membership directly.';

-- Item predicate in one place. Children (files, tickets, allocations, overlays,
-- checklist entries, entity_versions and audit rows of an item) are visible only
-- when this holds for their parent item; expenses stay visible as ledger rows but
-- their item_id is nulled for callers who cannot see the item.
CREATE FUNCTION tribo.item_visible(uid uuid, p_item_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tribo.items i
      JOIN tribo.trips t       ON t.id = i.trip_id AND t.deleted_at IS NULL
      JOIN tribo.memberships m ON m.trip_id = i.trip_id AND m.deleted_at IS NULL
      JOIN tribo.persons me    ON me.id = m.person_id AND me.user_id = uid
     WHERE i.id = p_item_id
       AND i.deleted_at IS NULL
       AND (i.visibility = 'shared' OR i.owner_membership_id = m.id
            OR (i.visibility = 'selected' AND EXISTS
                (SELECT 1 FROM tribo.item_shares s WHERE s.item_id = i.id AND s.membership_id = m.id))))
$$;

-- People are not a platform-wide library: a person row is visible to the person
-- themself, to its creator while it is still a placeholder (R19), and to anyone
-- sharing an active trip membership with it. Sensitive fields (emergency contact;
-- ID and passport in 1b) are further limited by the serializer to the person
-- themself and the owners/organizers of a shared trip.
CREATE FUNCTION tribo.person_visible(uid uuid, p_person_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tribo.persons p
     WHERE p.id = p_person_id AND p.deleted_at IS NULL
       AND (p.user_id = uid
            OR (p.created_by = uid AND p.user_id IS NULL)
            OR EXISTS (
              SELECT 1 FROM tribo.memberships theirs
                JOIN tribo.memberships mine ON mine.trip_id = theirs.trip_id
                JOIN tribo.persons me ON me.id = mine.person_id
                JOIN tribo.trips t ON t.id = theirs.trip_id
               WHERE theirs.person_id = p.id AND theirs.deleted_at IS NULL
                 AND mine.deleted_at IS NULL AND me.user_id = uid
                 AND t.deleted_at IS NULL)))
$$;

COMMENT ON FUNCTION tribo.item_visible(uuid, uuid) IS $c$Repository predicate (app side), set-based form,
with :mid = the caller's active membership in the item's trip (resolved once per request):
  item.deleted_at IS NULL AND :mid IS NOT NULL
  AND (item.visibility = 'shared' OR item.owner_membership_id = :mid
       OR (item.visibility = 'selected' AND EXISTS
           (SELECT 1 FROM tribo.item_shares s WHERE s.item_id = item.id AND s.membership_id = :mid)))
Child rows: (child.item_id IS NULL OR tribo.item_visible(:uid, child.item_id)).$c$;

-- ---------------------------------------------------------------------------
-- Audit (append-only, hash-chained, metadata only)
-- ---------------------------------------------------------------------------
-- Rows hold ids and metadata only — no field values, IP addresses or user agents —
-- so RA 10173 erasure never needs to touch this immutable log. IP and user agent
-- live in the app's JSON logs (shorter retention), joined by request_id.
--
-- Chains (R13):
--   'trip:<uuid>'  every write under a trip; retired whole after the trip has been
--                  archived or deleted for audit_retention_days
--   'auth:YYYY-MM' sign-in and credential events, one chain per UTC month, retired
--                  month by month; keeps login_failed off the platform lock
--   'platform'     library, people, admin and retirement records; kept for good
--
-- Routing is applied once, by the insert trigger, and stored in chain_key. R30: there is
-- deliberately no CHECK re-deriving it: rows are immutable, and a CHECK calling this
-- function would make every pg_dump restore re-validate old rows against the current
-- routing. Changing routing for new rows is therefore safe; old rows keep their key.

CREATE FUNCTION audit.chain_key_for(p_trip_id uuid, p_action text, p_occurred_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_trip_id IS NOT NULL THEN 'trip:' || p_trip_id::text
    WHEN p_action IN ('login', 'login_failed', 'logout', 'password_reset', 'password_change',
                      'mfa_enrol', 'mfa_reset', 'step_up')
      THEN 'auth:' || to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')
    ELSE 'platform'
  END
$$;

CREATE TABLE audit.audit_events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  chain_key      text NOT NULL,                     -- see audit.chain_key_for; set by trigger
  seq            bigint NOT NULL,                   -- set by trigger
  hash_version   smallint NOT NULL DEFAULT 1,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_tz       text,
  actor_user_id  uuid,                              -- no FK: audit outlives and never blocks user erasure
  surface        text NOT NULL CHECK (surface IN ('web', 'api', 'mcp', 'system')),
  client_id      text,                              -- PAT id or OAuth client_id
  client_name    text,                              -- from the client's CIMD; shown as "via AI"
  mcp_session    text,                              -- whatever session/correlation id the client sent
  action         text NOT NULL CHECK (action IN (
                   'create', 'update', 'delete', 'restore', 'share', 'role_change', 'approve', 'reject',
                   'claim', 'merge', 'erase', 'purge', 'reveal', 'revoke', 'export', 'break_glass',
                   'login', 'login_failed', 'logout', 'password_reset', 'password_change',
                   'mfa_enrol', 'mfa_reset', 'step_up')),
  entity_type    text NOT NULL CHECK (entity_type ~ '^[a-z_]{1,40}$'),
  entity_id      uuid,
  trip_id        uuid,
  version_before int,
  version_after  int,
  restored_from  int,
  reason         text,                              -- break-glass reason; for reveal, the field path(s) shown
  request_id     text,                              -- joins to the request's log lines (IP, user agent)
  prev_hash      bytea NOT NULL,                    -- set by trigger
  hash           bytea NOT NULL,                    -- set by trigger
  UNIQUE (chain_key, seq),
  CONSTRAINT audit_break_glass_reason CHECK (action <> 'break_glass' OR reason IS NOT NULL),
  CONSTRAINT audit_reveal_fields CHECK (action <> 'reveal' OR reason IS NOT NULL)
);
COMMENT ON CONSTRAINT audit_reveal_fields ON audit.audit_events IS
  'A reveal records which field paths were shown (e.g. booking_ref), never their values.';
CREATE INDEX audit_events_trip_time_idx   ON audit.audit_events (trip_id, occurred_at);
CREATE INDEX audit_events_actor_time_idx  ON audit.audit_events (actor_user_id, occurred_at);
CREATE INDEX audit_events_entity_seq_idx  ON audit.audit_events (entity_id, seq);
-- Restore undeletes the children removed by the same request.
CREATE INDEX audit_events_request_idx    ON audit.audit_events (request_id) WHERE request_id IS NOT NULL;

-- Canonical text that each hash covers. Explicit field list (not to_jsonb(row)) so
-- adding columns later never changes old hashes; bump hash_version if it must change.
CREATE FUNCTION audit.canonical(e audit.audit_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'v', e.hash_version, 'id', e.id, 'chain_key', e.chain_key, 'seq', e.seq,
    'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_tz', e.actor_tz, 'actor_user_id', e.actor_user_id, 'surface', e.surface,
    'client_id', e.client_id, 'client_name', e.client_name, 'mcp_session', e.mcp_session,
    'action', e.action, 'entity_type', e.entity_type, 'entity_id', e.entity_id, 'trip_id', e.trip_id,
    'version_before', e.version_before, 'version_after', e.version_after,
    'restored_from', e.restored_from, 'reason', e.reason, 'request_id', e.request_id)::text
$$;

-- Insert trigger: serialise per chain with an advisory xact lock, then link.
-- Requires READ COMMITTED (the app default); UNIQUE (chain_key, seq) backstops it.
-- A transaction that writes to two chains takes them in a fixed order (trip before
-- platform) to avoid lock-order deadlocks.
-- R31: occurred_at is always the server's clock (only a superuser session, i.e.
-- maintenance or tests, may supply its own), so no caller can backdate an event into an
-- old or retired chain. R29: no trip-scoped event is accepted once the trip's chain is
-- retired, which freezes the trip.
CREATE FUNCTION audit.chain_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) THEN
    NEW.occurred_at := now();
  END IF;
  IF NEW.trip_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM tribo.trips t WHERE t.id = NEW.trip_id AND t.audit_retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'trip % is retired; no further changes', NEW.trip_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trip_retired';
  END IF;
  NEW.chain_key    := audit.chain_key_for(NEW.trip_id, NEW.action, NEW.occurred_at);
  NEW.hash_version := 1;
  PERFORM pg_advisory_xact_lock(hashtextextended('tribo.audit:' || NEW.chain_key, 0));
  SELECT e.seq, e.hash INTO last_seq, last_hash
    FROM audit.audit_events e
   WHERE e.chain_key = NEW.chain_key
   ORDER BY e.seq DESC LIMIT 1;
  NEW.seq       := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, decode(repeat('00', 32), 'hex'));
  NEW.hash      := pg_catalog.sha256(NEW.prev_hash || convert_to(audit.canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.chain_event();

-- Append-only: no UPDATE ever; DELETE only from inside audit.retire_chain().
CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('tribo.audit_purge_chain', true) = OLD.chain_key THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit.audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

-- On-demand verification from the admin console. Returns the first broken seq,
-- or NULL when the chain is intact.
CREATE FUNCTION audit.verify_chain(p_chain_key text) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e        audit.audit_events;
  expected bytea := decode(repeat('00', 32), 'hex');
  n        bigint := 0;
BEGIN
  FOR e IN SELECT * FROM audit.audit_events WHERE chain_key = p_chain_key ORDER BY seq LOOP
    n := n + 1;
    IF e.seq <> n OR e.prev_hash <> expected
       OR e.hash <> pg_catalog.sha256(e.prev_hash || convert_to(audit.canonical(e), 'UTF8')) THEN
      RETURN e.seq;
    END IF;
    expected := e.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Retention (slice 1b). Internal: deletes one chain whole and records its final head
-- in the platform chain. Not callable by tribo_app; only through the due-checked
-- SECURITY DEFINER wrappers below (owned by tribo_owner).
CREATE FUNCTION audit.retire_chain(p_chain_key text, p_entity_id uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head_seq bigint;
  head     bytea;
  n        bigint;
BEGIN
  SELECT e.seq, e.hash INTO head_seq, head
    FROM audit.audit_events e WHERE e.chain_key = p_chain_key ORDER BY e.seq DESC LIMIT 1;
  IF head_seq IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('tribo.audit_purge_chain', p_chain_key, true);
  DELETE FROM audit.audit_events WHERE chain_key = p_chain_key;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('tribo.audit_purge_chain', '', true);

  INSERT INTO audit.audit_events (surface, action, entity_type, entity_id, reason)
  VALUES ('system', 'purge', 'audit_chain', p_entity_id,
          format('retention: chain %s retired at seq %s, head %s', p_chain_key, head_seq, encode(head, 'hex')));
  RETURN n;
END $$;

-- Trip chain: due audit_retention_days after the trip was archived or soft-deleted
-- (the later of the two when both). Locks the trip row so no write can slip in between
-- the due check and the retirement, then marks the trip retired (R29).
CREATE FUNCTION audit.purge_trip_chain(p_trip_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM 1 FROM tribo.trips t WHERE t.id = p_trip_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM tribo.trips t, tribo.platform_settings s
     WHERE t.id = p_trip_id AND t.audit_retired_at IS NULL
       AND greatest(t.archived_at, t.deleted_at) + make_interval(days => s.audit_retention_days) <= now()) THEN
    RAISE EXCEPTION 'trip % is not past audit retention', p_trip_id;
  END IF;
  -- Purging a file writes a trip-scoped audit event, which retirement would block:
  -- every file that retention will ever purge (sensitive or deleted) goes first.
  IF EXISTS (SELECT 1 FROM tribo.files f
              WHERE f.trip_id = p_trip_id AND f.purged_at IS NULL
                AND (f.sensitive OR f.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'trip % has files awaiting purge', p_trip_id;
  END IF;
  n := audit.retire_chain('trip:' || p_trip_id::text, p_trip_id);
  UPDATE tribo.trips SET audit_retired_at = now() WHERE id = p_trip_id;
  RETURN n;
END $$;

-- Auth chain of one UTC month ('YYYY-MM'): due audit_retention_days after the month ends.
CREATE FUNCTION audit.purge_auth_chain(p_month text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  month_end timestamptz;
BEGIN
  IF p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid month %', p_month;
  END IF;
  month_end := (to_date(p_month || '-01', 'YYYY-MM-DD') + interval '1 month')::timestamp AT TIME ZONE 'UTC';
  IF NOT EXISTS (
    SELECT 1 FROM tribo.platform_settings s
     WHERE month_end + make_interval(days => s.audit_retention_days) <= now()) THEN
    RAISE EXCEPTION 'auth chain % is not past audit retention', p_month;
  END IF;
  RETURN audit.retire_chain('auth:' || p_month, NULL);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA tribo, audit FROM PUBLIC;
GRANT USAGE ON SCHEMA tribo, audit TO tribo_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tribo TO tribo_app;
REVOKE INSERT, DELETE ON tribo.platform_settings FROM tribo_app;  -- singleton: update only
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tribo TO tribo_app;

GRANT SELECT, INSERT ON audit.audit_events TO tribo_app;          -- no UPDATE/DELETE/TRUNCATE
REVOKE ALL ON FUNCTION audit.retire_chain(text, uuid), audit.purge_trip_chain(uuid),
                       audit.purge_auth_chain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.purge_trip_chain(uuid), audit.purge_auth_chain(text),
                          audit.verify_chain(text), audit.canonical(audit.audit_events),
                          audit.chain_key_for(uuid, text, timestamptz) TO tribo_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA tribo GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tribo_app;

-- End of 0001; the runner commits it.
