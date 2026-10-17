import type { Kysely } from 'kysely';
import type { DB } from './generated/db.js';

/**
 * The one owner of every table (the one-owner rule). Only the owner's repository gets a
 * handle that can name the table; everyone else goes through the owner's service.ts.
 * `satisfies Record<keyof DB, …>` makes a table added by a migration but missing here a
 * type error, so every new table must be given an owner.
 */
export const TABLE_OWNER = {
  'tribo.users': 'identity',
  'tribo.sessions': 'identity',
  'tribo.personal_access_tokens': 'identity',
  'tribo.password_reset_links': 'identity',
  'tribo.mfa_recovery_codes': 'identity',
  'tribo.mcp_clients': 'identity',
  'tribo.oauth_store': 'identity',
  'tribo.approvals': 'identity',
  'tribo.platform_settings': 'identity',

  'tribo.trips': 'trips',
  'tribo.trip_destinations': 'trips',
  'tribo.memberships': 'trips',
  'tribo.invites': 'trips',

  'tribo.items': 'items',
  'tribo.item_shares': 'items',
  'tribo.units': 'items',
  'tribo.allocations': 'items',
  'tribo.tickets': 'items',
  'tribo.overlays': 'items',
  'tribo.checklist_entries': 'items',

  'tribo.expenses': 'expenses',
  'tribo.expense_shares': 'expenses',
  'tribo.budget_lines': 'expenses',

  'tribo.files': 'documents',

  'tribo.persons': 'library',
  'tribo.places': 'library',
  'tribo.vendors': 'library',
  'tribo.templates': 'library',

  'audit.audit_events': 'audit',
  'tribo.entity_versions': 'audit',

  'tribo.idempotency_keys': 'platform',
} as const satisfies Record<keyof DB, string>;

/** Core modules plus the platform package (write path, idempotency). Itinerary owns no table. */
export type TableOwner = (typeof TABLE_OWNER)[keyof typeof TABLE_OWNER] | 'itinerary';

export type TablesOf<M extends TableOwner> = {
  [T in keyof typeof TABLE_OWNER]: (typeof TABLE_OWNER)[T] extends M ? T : never;
}[keyof typeof TABLE_OWNER];

/** The slice of the schema one owner may name. */
export type ModuleTables<M extends TableOwner> = Pick<DB, TablesOf<M>>;

/** A Kysely handle (or transaction) that compiles only against the owner's own tables. */
export type ModuleDb<M extends TableOwner> = Kysely<ModuleTables<M>>;

/**
 * Narrows the app's handle for one owner's repository. The cast is sound: the narrowed
 * schema is a subset of DB, and the same connection or transaction is reused.
 */
export function forModule<M extends TableOwner>(db: Kysely<DB>, _owner: M): ModuleDb<M> {
  return db as unknown as ModuleDb<M>;
}
