// What the expenses stories test against: the board world's trip (one member of each role,
// an outsider, a shared guest house owned by the trip owner, PHP) plus a placeholder member,
// a private item of another member, and a trip elsewhere with a member of its own. Each call
// builds a fresh trip, so tests never share rows.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import {
  createExpensesService,
  writePath,
  type ExpenseRecord,
  type ExpensesService,
} from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { addMember, createItem, createPlaceholder, createTrip, createUser } from './factories.js';
import { oracle, type BuiltWorld } from './leak.js';

export function expensesService(db: Kysely<DB>): ExpensesService {
  return createExpensesService(db, writePath(db));
}

/** A membership id as a body names it. */
export const mem = (membershipId: string) => encodeTypeId(ID_PREFIX.membership, membershipId);

/** An item id as a body names it. */
export const itm = (itemId: string) => encodeTypeId(ID_PREFIX.item, itemId);

export async function expensesWorld(tdb: TestDatabase) {
  const w = await boardWorld(tdb);
  const placeholderPerson = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
  const placeholder = await addMember(tdb.db, {
    tripId: w.tripId,
    personId: placeholderPerson,
    role: 'member',
  });
  const hidden = await createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: w.other.membershipId,
    type: 'note',
    title: 'Surprise for the owner',
    visibility: 'private',
  });
  const elsewhereOwner = await createUser(tdb.db);
  const elsewhere = await createTrip(tdb.db, { owner: elsewhereOwner });
  return { ...w, placeholder, hidden, elsewhere };
}

export type ExpensesWorld = Awaited<ReturnType<typeof expensesWorld>>;

/** A dinner of PHP 1,000.00 the member paid, split equally among owner, member and organizer. */
export function dinner(w: ExpensesWorld, overrides: Record<string, unknown> = {}) {
  return {
    category: 'food',
    description: 'Dinner at Coco Grove',
    spentOn: '2026-11-12',
    payerMembershipId: mem(w.member.membershipId),
    amount: { amountMinor: 100_000, currency: 'PHP' },
    split: {
      method: 'equal',
      membershipIds: [w.owner.membershipId, w.member.membershipId, w.organizer.membershipId].map(
        mem,
      ),
    },
    ...overrides,
  };
}

/** The expense row and its shares as stored. */
export async function expenseRows(tdb: TestDatabase, expenseId: string) {
  const expense = await tdb.db
    .selectFrom('tribo.expenses')
    .selectAll()
    .where('id', '=', expenseId)
    .executeTakeFirst();
  const shares = await tdb.db
    .selectFrom('tribo.expense_shares')
    .select(['membership_id', 'share_minor'])
    .where('expense_id', '=', expenseId)
    .orderBy('membership_id')
    .execute();
  return { expense, shares };
}

export async function expenseCount(tdb: TestDatabase, tripId: string): Promise<number> {
  const { n } = await tdb.db
    .selectFrom('tribo.expenses')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('trip_id', '=', tripId)
    .executeTakeFirstOrThrow();
  return Number(n);
}

/**
 * What the oracle forbids in the expenses one account read, and what it requires: the item
 * link only where the item shows to them (and then always), and the amounts only where
 * they read costs (and then exactly as stored), with no amount anywhere else.
 */
export function expenseLeaks(
  world: BuiltWorld,
  userId: string,
  read: readonly ExpenseRecord[],
): string[] {
  const problems: string[] = [];
  for (const expense of read) {
    const stored = world.trips.flatMap((t) => t.expenses).find((e) => e.id === expense.id) ?? {
      shares: [],
    };
    const itemId = oracle.expenseItem(world, userId, expense.id);
    if (expense.itemId !== itemId) {
      problems.push(
        `${userId} reads ${expense.id} on item ${String(expense.itemId)}, not ${String(itemId)}`,
      );
    }
    const total = stored.shares.reduce((sum, s) => sum + s.amount, 0);
    const money = (amountMinor: number) => ({ amountMinor, currency: 'PHP' });
    const expected = oracle.costsReadable(world, userId, expense.tripId)
      ? {
          amount: money(total),
          tripAmount: money(total),
          shares: stored.shares
            .map((s) => ({ membershipId: s.membershipId, amount: money(s.amount) }))
            .sort((a, b) => (a.membershipId < b.membershipId ? -1 : 1)),
        }
      : {
          amount: { masked: true },
          tripAmount: { masked: true },
          shares: stored.shares
            .map((s) => ({ membershipId: s.membershipId, amount: { masked: true } }))
            .sort((a, b) => (a.membershipId < b.membershipId ? -1 : 1)),
        };
    const shown = {
      amount: expense.amount,
      tripAmount: expense.tripAmount,
      shares: expense.shares,
    };
    if (JSON.stringify(shown) !== JSON.stringify(expected)) {
      problems.push(`${userId} reads the amounts of ${expense.id} as ${JSON.stringify(shown)}`);
    }
    if (
      !oracle.costsReadable(world, userId, expense.tripId) &&
      JSON.stringify(expense).includes('amountMinor')
    ) {
      problems.push(`${userId} reads an amount somewhere in ${expense.id}`);
    }
  }
  return problems;
}
