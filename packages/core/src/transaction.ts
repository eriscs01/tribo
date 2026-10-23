import type { DB } from '@tribo/db';
import type { Tx } from '@tribo/platform';
import type { Kysely } from 'kysely';

/**
 * Runs `work` in the caller's transaction when it is one, or in a new one: the reads that
 * write an audit event (reveals, sensitive downloads) keep the event and the answer together,
 * and a leak test that passes its own transaction still sees its uncommitted rows.
 */
export function inTransaction<T>(db: Kysely<DB>, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.isTransaction ? work(db as Tx) : db.transaction().execute(work);
}
