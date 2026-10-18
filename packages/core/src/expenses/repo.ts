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
