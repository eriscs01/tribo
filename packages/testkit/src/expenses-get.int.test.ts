// @module-tag drop-b
// expenses.get (Drop B): Expense with shares; As expenses.list
// Through the expenses service and the real trips and items modules: one expense with its
// shares to every member of its trip, masked for a viewer without a cost grant, its item
// link nulled where the item is hidden, and one answer, from the same queries, for every
// expense the caller may not see.
import type { ExpensesService } from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createExpense, createUser, softDelete } from './factories.js';
import { expensesService, expensesWorld, type ExpensesWorld } from './expenses-world.js';

let tdb: TestDatabase;
let expenses: ExpensesService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  expenses = expensesService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

/** A handle that counts the statements run through it. */
function counted(db: Kysely<DB>) {
  const state = { queries: 0 };
  const handle = db.withPlugin({
    transformQuery(args) {
      state.queries += 1;
      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  });
  return { handle, state };
}

/** PHP 900.00 the member paid on the guest house, shared by the member and the viewer. */
function lodgingExpense(w: ExpensesWorld, init: { itemId?: string | null; voided?: boolean } = {}) {
  return createExpense(tdb.db, {
    tripId: w.tripId,
    payerMembershipId: w.member.membershipId,
    itemId: init.itemId === undefined ? w.lodging : init.itemId,
    voided: init.voided ?? false,
    shares: [
      { membershipId: w.member.membershipId, amount: 60_000 },
      { membershipId: w.viewer.membershipId, amount: 30_000 },
    ],
  });
}

describe('expenses.get', () => {
  it('answers the expense with its shares to the owner, an organizer, a member and a viewer', async () => {
    const w = await expensesWorld(tdb);
    const id = await lodgingExpense(w);
    for (const who of [w.owner, w.organizer, w.member, w.other]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await expenses.get(who.userId, id)).toMatchObject({
        id,
        tripId: w.tripId,
        itemId: w.lodging,
        payerMembershipId: w.member.membershipId,
        amount: { amountMinor: 90_000, currency: 'PHP' },
        tripAmount: { amountMinor: 90_000, currency: 'PHP' },
        fxRate: '1',
        splitMethod: 'itemised',
        shares: [w.member.membershipId, w.viewer.membershipId].sort().map((membershipId) => ({
          membershipId,
          amount: {
            amountMinor: membershipId === w.member.membershipId ? 60_000 : 30_000,
            currency: 'PHP',
          },
        })),
        version: 1,
      });
    }
    expect((await expenses.get(w.viewer.userId, id)).id).toBe(id);
  });

  it('masks every amount for a viewer without canViewCosts, and shows them with the grant', async () => {
    const w = await expensesWorld(tdb);
    const id = await lodgingExpense(w);
    const masked = await expenses.get(w.viewer.userId, id);
    expect(masked.amount).toEqual({ masked: true });
    expect(masked.tripAmount).toEqual({ masked: true });
    expect(masked.shares.map((s) => s.amount)).toEqual([{ masked: true }, { masked: true }]);
    expect(JSON.stringify(masked)).not.toMatch(/amountMinor|90000|60000|30000/);
    // Who is in the split and how is no amount: they still show.
    expect(masked.shares.map((s) => s.membershipId)).toEqual(
      [w.member.membershipId, w.viewer.membershipId].sort(),
    );

    const granted = await createUser(tdb.db);
    await addMember(tdb.db, {
      tripId: w.tripId,
      personId: granted.personId,
      role: 'viewer',
      canViewCosts: true,
    });
    expect((await expenses.get(granted.userId, id)).tripAmount).toEqual({
      amountMinor: 90_000,
      currency: 'PHP',
    });
  });

  it('nulls the item link for a caller who cannot see the item, and keeps the expense', async () => {
    const w = await expensesWorld(tdb);
    const id = await lodgingExpense(w, { itemId: w.hidden });
    expect((await expenses.get(w.other.userId, id)).itemId).toBe(w.hidden);
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect((await expenses.get(who.userId, id)).itemId).toBeNull();
    }
    await softDelete(tdb.db, 'tribo.items', w.hidden);
    expect((await expenses.get(w.other.userId, id)).itemId).toBeNull();
  });

  it('answers not_found outside the trip, to a removed member, on a deleted trip and once voided', async () => {
    const w = await expensesWorld(tdb);
    const id = await lodgingExpense(w);
    const voided = await lodgingExpense(w, { voided: true });
    expect(await refusal(expenses.get(w.outsider.userId, id))).toBe('not_found');
    expect(await refusal(expenses.get(w.member.userId, voided))).toBe('not_found');
    expect(
      await refusal(expenses.get(w.member.userId, '0192f000-0000-7000-8000-00000000000a')),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(expenses.get(w.other.userId, id))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(expenses.get(w.owner.userId, id))).toBe('not_found');
  });

  it('runs the same queries whether the expense is voided, elsewhere or unknown', async () => {
    const w = await expensesWorld(tdb);
    const voided = await lodgingExpense(w, { voided: true });
    const foreign = await createExpense(tdb.db, {
      tripId: w.elsewhere.tripId,
      payerMembershipId: w.elsewhere.ownerMembershipId,
      shares: [{ membershipId: w.elsewhere.ownerMembershipId, amount: 1_000 }],
    });
    const counts = [];
    for (const id of [voided, foreign, '0192f000-0000-7000-8000-00000000000b']) {
      const { handle, state } = counted(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await refusal(expensesService(handle).get(w.member.userId, id))).toBe('not_found');
      counts.push(state.queries);
    }
    expect(new Set(counts).size).toBe(1);
  });
});
