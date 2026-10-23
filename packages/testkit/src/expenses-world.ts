// What the expenses stories test against: the board world's trip (one member of each role,
// an outsider, a shared guest house owned by the trip owner, PHP) plus a placeholder member,
// a private item of another member, and a trip elsewhere with a member of its own. Each call
// builds a fresh trip, so tests never share rows.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { createExpensesService, writePath, type ExpensesService } from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { addMember, createItem, createPlaceholder, createTrip, createUser } from './factories.js';

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
