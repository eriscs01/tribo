import type { ModuleDb } from '@tribo/db';
import { sql } from 'kysely';

/** The expenses module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ExpensesDb = ModuleDb<'expenses'>;

/** True when the trip has any expense row, voided ones included, or any budget line. */
export async function hasMoneyRows(db: ExpensesDb, tripId: string): Promise<boolean> {
  const expense = db
    .selectFrom('tribo.expenses')
    .select(sql`1`.as('one'))
    .where('trip_id', '=', tripId);
  const line = db
    .selectFrom('tribo.budget_lines')
    .select(sql`1`.as('one'))
    .where('trip_id', '=', tripId);
  const row = await expense.unionAll(line).limit(1).executeTakeFirst();
  return row !== undefined;
}

/** The sum of one membership's shares on the trip's expenses that are not voided. */
export async function sumShares(
  db: ExpensesDb,
  tripId: string,
  membershipId: string,
): Promise<number> {
  const row = await db
    .selectFrom('tribo.expense_shares as s')
    .innerJoin('tribo.expenses as e', 'e.id', 's.expense_id')
    .select(sql<string>`coalesce(sum(s.share_minor), 0)::text`.as('total'))
    .where('e.trip_id', '=', tripId)
    .where('e.deleted_at', 'is', null)
    .where('s.membership_id', '=', membershipId)
    .executeTakeFirstOrThrow();
  return Number(row.total);
}
