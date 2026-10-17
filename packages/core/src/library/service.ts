import { forModule } from '@tribo/db';
import type { Change, Tx } from '@tribo/platform';
import { insertAccountPerson } from './repo.js';

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
