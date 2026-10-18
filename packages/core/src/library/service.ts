import { forModule, type DB } from '@tribo/db';
import type { Change, Tx } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { findAccountPerson, insertAccountPerson } from './repo.js';

/**
 * Every account has exactly one person, made with the account. Returns the person's
 * create as a change for the caller to record in the same transaction.
 */
export async function createAccountPerson(
  tx: Tx,
  account: { userId: string; displayName: string },
): Promise<Change<{ personId: string }>> {
  const row = await insertAccountPerson(
    forModule(tx, 'library'),
    account.userId,
    account.displayName,
  );
  return {
    action: 'create',
    aggregate: 'person',
    entityId: row.id,
    tripId: null,
    version: row.version,
    snapshot: { userId: row.user_id, displayName: row.display_name },
    result: { personId: row.id },
  };
}

/** The person an account is inside every trip, through its memberships; null if it has none. */
export async function accountPersonId(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await findAccountPerson(forModule(db, 'library'), userId);
  return row?.id ?? null;
}
