import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';
import type { Share } from './money.js';

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

export interface NewExpense {
  tripId: string;
  itemId: string | null;
  category: string;
  description: string;
  spentOn: string;
  payerMembershipId: string;
  amountMinor: number;
  currency: string;
  fxRate: string;
  tripAmountMinor: number;
  splitMethod: ValueOf<'tribo.expenses.split_method'>;
  createdBy: string;
}

/** Records an expense with its shares (owned rows, frozen here); returns its id. */
export async function insertExpense(
  db: ExpensesDb,
  expense: NewExpense,
  shares: readonly Share[],
): Promise<string> {
  const { id } = await db
    .insertInto('tribo.expenses')
    .values({
      trip_id: expense.tripId,
      item_id: expense.itemId,
      category: expense.category,
      description: expense.description,
      spent_on: expense.spentOn,
      payer_membership_id: expense.payerMembershipId,
      amount_minor: expense.amountMinor,
      currency: expense.currency,
      fx_rate: expense.fxRate,
      trip_amount_minor: expense.tripAmountMinor,
      split_method: expense.splitMethod,
      created_by: expense.createdBy,
      updated_by: expense.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await insertShares(db, id, expense.tripId, shares);
  return id;
}

async function insertShares(
  db: ExpensesDb,
  expenseId: string,
  tripId: string,
  shares: readonly Share[],
): Promise<void> {
  await db
    .insertInto('tribo.expense_shares')
    .values(
      shares.map((s) => ({
        expense_id: expenseId,
        trip_id: tripId,
        membership_id: s.membershipId,
        share_minor: s.shareMinor,
      })),
    )
    .execute();
}

/**
 * An expense's columns as a reader gets them: item_id only when the reader sees that item
 * (tribo.item_visible), null otherwise. The ledger stays whole, the link does not leak
 * (Technical design, "The ledger stays whole").
 */
function selectExpense(db: ExpensesDb, userId: string) {
  return db
    .selectFrom('tribo.expenses as e')
    .select([
      'e.id',
      'e.trip_id',
      'e.item_id',
      sql<
        string | null
      >`CASE WHEN e.item_id IS NOT NULL AND tribo.item_visible(${userId}, e.item_id) THEN e.item_id END`.as(
        'shown_item_id',
      ),
      'e.category',
      'e.description',
      sql<string>`e.spent_on::text`.as('spent_on'),
      'e.payer_membership_id',
      'e.amount_minor',
      'e.currency',
      sql<string>`e.fx_rate::text`.as('fx_rate'),
      'e.trip_amount_minor',
      'e.split_method',
      'e.version',
      'e.created_at',
      'e.updated_at',
    ]);
}

export type ExpenseRow = NonNullable<Awaited<ReturnType<typeof findExpense>>>;

/** For the writer that just created or changed it, inside its transaction. */
export function findExpense(db: ExpensesDb, userId: string, expenseId: string) {
  return selectExpense(db, userId).where('e.id', '=', expenseId).executeTakeFirst();
}

/** The shares of these expenses, in membership order within each. */
export function listShares(db: ExpensesDb, expenseIds: readonly string[]) {
  if (expenseIds.length === 0) return Promise.resolve([]);
  return db
    .selectFrom('tribo.expense_shares')
    .select(['expense_id', 'membership_id', 'share_minor'])
    .where('expense_id', 'in', expenseIds)
    .orderBy('expense_id')
    .orderBy('membership_id')
    .execute();
}

/** The trip an expense row is in, voided or not; undefined when there is no such row. */
export async function expenseTrip(db: ExpensesDb, expenseId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('tribo.expenses')
    .select('trip_id')
    .where('id', '=', expenseId)
    .executeTakeFirst();
  return row?.trip_id;
}

/** The expense unless it is voided, as this reader gets it. */
export function findLiveExpense(db: ExpensesDb, userId: string, expenseId: string) {
  return selectExpense(db, userId)
    .where('e.id', '=', expenseId)
    .where('e.deleted_at', 'is', null)
    .executeTakeFirst();
}
