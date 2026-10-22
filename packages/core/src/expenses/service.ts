import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { hasMoneyRows, sumShares } from './repo.js';

/**
 * R9: money is recorded in the trip currency once the trip has an expense or a budget
 * line. A voided expense counts too: its frozen amounts come back on restore.
 */
export function moneyRecorded(db: Kysely<DB>, tripId: string): Promise<boolean> {
  return hasMoneyRows(forModule(db, 'expenses'), tripId);
}

/**
 * "My share" (R36): the sum of this membership's shares on the trip's expenses not voided,
 * in minor units of the trip currency; 0 with none. Never a balance: what the member paid
 * and who owes whom are not part of it. Whether the caller may see it is theirs to check.
 */
export function memberShare(db: Kysely<DB>, tripId: string, membershipId: string): Promise<number> {
  return sumShares(forModule(db, 'expenses'), tripId, membershipId);
}
