import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { hasMoneyRows } from './repo.js';

/**
 * R9: money is recorded in the trip currency once the trip has an expense or a budget
 * line. A voided expense counts too: its frozen amounts come back on restore.
 */
export function moneyRecorded(db: Kysely<DB>, tripId: string): Promise<boolean> {
  return hasMoneyRows(forModule(db, 'expenses'), tripId);
}
