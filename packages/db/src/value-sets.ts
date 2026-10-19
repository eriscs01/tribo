/**
 * The one TypeScript owner of every closed value set the schema declares as
 * `text CHECK (column IN (...))` (closed sets are text + CHECK rather than enums so
 * migrations can add values; see the header of 0001_init.sql). The compiler cannot see a
 * CHECK and kysely-codegen types these columns as `string`, so every other copy derives
 * from here, and packages/testkit/src/value-sets.int.test.ts reads pg_constraint and fails
 * when a migration adds, removes or changes a set without updating this map.
 * Keys are `schema.table.column`; order follows the migration.
 */
export const VALUE_SETS = {
  'tribo.users.platform_role': ['admin', 'user'],
  'tribo.users.status': ['active', 'disabled'],
  'tribo.personal_access_tokens.scope': ['read', 'write'],
  'tribo.places.kind': [
    'destination',
    'beach',
    'landmark',
    'port',
    'airport',
    'lodging',
    'restaurant',
    'other',
  ],
  'tribo.vendors.kind': [
    'airline',
    'lodging',
    'tour_operator',
    'rental',
    'ferry_line',
    'bus_line',
    'restaurant',
    'other',
  ],
  'tribo.templates.kind': ['trip', 'packing', 'checklist', 'budget'],
  'tribo.trips.status': ['draft', 'planning', 'active', 'completed'],
  'tribo.memberships.trip_role': ['owner', 'organizer', 'member', 'viewer'],
  'tribo.invites.role': ['organizer', 'member', 'viewer'],
  'tribo.items.type': [
    'transport',
    'lodging',
    'ground',
    'activity',
    'meal',
    'task',
    'note',
    'document',
  ],
  'tribo.items.status': ['draft', 'planned', 'booked', 'confirmed', 'open', 'done', 'cancelled'],
  'tribo.items.visibility': ['shared', 'private', 'selected'],
  // An array column held to a set (CHECK restricted_fields <@ ARRAY[...], 0002).
  'tribo.items.restricted_fields': ['cost', 'bookingRef', 'cardLast4'],
  'tribo.units.kind': ['room', 'vehicle'],
  'tribo.allocations.role': ['attendee', 'occupant', 'driver', 'passenger', 'assignee'],
  'tribo.allocations.rsvp': ['pending', 'yes', 'no', 'maybe'],
  'tribo.expenses.split_method': ['equal', 'weight', 'itemised'],
  'tribo.files.kind': ['id', 'ticket', 'voucher', 'photo', 'other'],
  'tribo.files.visibility': ['shared', 'private'],
  'tribo.files.mime_type': [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/webp',
  ],
  'tribo.approvals.status': ['pending', 'approved', 'rejected', 'failed'],
  'audit.audit_events.surface': ['web', 'api', 'mcp', 'system'],
  'audit.audit_events.action': [
    'create',
    'update',
    'delete',
    'restore',
    'share',
    'role_change',
    'approve',
    'reject',
    'claim',
    'merge',
    'erase',
    'purge',
    'reveal',
    'revoke',
    'export',
    'break_glass',
    'login',
    'login_failed',
    'logout',
    'password_reset',
    'password_change',
    'mfa_enrol',
    'mfa_reset',
    'step_up',
  ],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type ValueSetKey = keyof typeof VALUE_SETS;

/** The union of values one CHECK allows, e.g. `ValueOf<'tribo.items.visibility'>`. */
export type ValueOf<K extends ValueSetKey> = (typeof VALUE_SETS)[K][number];
