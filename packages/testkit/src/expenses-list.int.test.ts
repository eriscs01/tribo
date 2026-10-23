// @module-tag drop-b
// expenses.list (Drop B): Trip ledger; All members; itemId nulled if item hidden; amounts masked for viewers w/o canViewCosts; Record only: no balances, debts or settle-up (R36)
// Through the expenses service and the real trips and items modules: the trip's ledger to
// every member, page by page, masked and with hidden item links nulled per caller, from a
// fixed number of queries whatever the trip holds.
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

/** The member's expense of `amount` on `spentOn`, shared with the owner. */
function spent(
  w: ExpensesWorld,
  spentOn: string,
  init: { itemId?: string; voided?: boolean; amount?: number } = {},
) {
  return createExpense(tdb.db, {
    tripId: w.tripId,
    payerMembershipId: w.member.membershipId,
    spentOn,
    itemId: init.itemId ?? null,
    voided: init.voided ?? false,
    shares: [
      { membershipId: w.member.membershipId, amount: init.amount ?? 10_000 },
      { membershipId: w.owner.membershipId, amount: init.amount ?? 10_000 },
    ],
  });
}

const page = { limit: 50 };

describe('expenses.list', () => {
  it('lists the ledger to every role, by the day spent then the order recorded, voided ones aside', async () => {
    const w = await expensesWorld(tdb);
    const third = await spent(w, '2026-11-13');
    const first = await spent(w, '2026-11-11');
    const second = await spent(w, '2026-11-12');
    const fourth = await spent(w, '2026-11-13');
    await spent(w, '2026-11-12', { voided: true });
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const listed = await expenses.list(who.userId, w.tripId, page);
      expect(listed.items.map((e) => e.id)).toEqual([first, second, third, fourth]);
      expect(listed.nextCursor).toBeNull();
    }
  });

  it('answers an empty ledger, and only expenses: no balance, debt or settle-up (R36)', async () => {
    const w = await expensesWorld(tdb);
    expect(await expenses.list(w.member.userId, w.tripId, page)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('masks every amount for a viewer without canViewCosts, not for one with it', async () => {
    const w = await expensesWorld(tdb);
    await spent(w, '2026-11-12', { amount: 12_345 });
    const [masked] = (await expenses.list(w.viewer.userId, w.tripId, page)).items;
    expect(masked?.amount).toEqual({ masked: true });
    expect(masked?.tripAmount).toEqual({ masked: true });
    expect(masked?.shares.every((s) => 'masked' in s.amount)).toBe(true);
    expect(JSON.stringify(masked)).not.toMatch(/amountMinor|12345|24690/);

    const granted = await createUser(tdb.db);
    await addMember(tdb.db, {
      tripId: w.tripId,
      personId: granted.personId,
      role: 'viewer',
      canViewCosts: true,
    });
    const [shown] = (await expenses.list(granted.userId, w.tripId, page)).items;
    expect(shown?.tripAmount).toEqual({ amountMinor: 24_690, currency: 'PHP' });
  });

  it('keeps an expense on a hidden item in the ledger with its item link nulled', async () => {
    const w = await expensesWorld(tdb);
    const id = await spent(w, '2026-11-12', { itemId: w.hidden });
    const onLodging = await spent(w, '2026-11-13', { itemId: w.lodging });
    const forMember = (await expenses.list(w.member.userId, w.tripId, page)).items;
    expect(forMember.map((e) => [e.id, e.itemId])).toEqual([
      [id, null],
      [onLodging, w.lodging],
    ]);
    const forOther = (await expenses.list(w.other.userId, w.tripId, page)).items;
    expect(forOther.map((e) => e.itemId)).toEqual([w.hidden, w.lodging]);
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await expensesWorld(tdb);
    await spent(w, '2026-11-12');
    expect(await refusal(expenses.list(w.outsider.userId, w.tripId, page))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(expenses.list(w.other.userId, w.tripId, page))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(expenses.list(w.owner.userId, w.tripId, page))).toBe('not_found');
  });

  it('pages one expense at a time through the same ledger, and refuses a cursor it did not make', async () => {
    const w = await expensesWorld(tdb);
    const ids = [
      await spent(w, '2026-11-13'),
      await spent(w, '2026-11-11'),
      await spent(w, '2026-11-13'),
      await spent(w, '2026-11-12'),
    ];
    const all = (await expenses.list(w.member.userId, w.tripId, page)).items.map((e) => e.id);
    expect([...all].sort()).toEqual([...ids].sort());
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page follows the last
      const next = await expenses.list(w.member.userId, w.tripId, {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      walked.push(...next.items.map((e) => e.id));
      cursor = next.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(walked).toEqual(all);

    for (const bad of [
      Buffer.from(JSON.stringify(['x'])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-11-12', 'not-a-uuid'])).toString('base64url'),
      Buffer.from(JSON.stringify(['12/11/2026', ids[0]])).toString('base64url'),
      'not a cursor',
    ]) {
      expect(
        // eslint-disable-next-line no-await-in-loop -- one read at a time
        await refusal(expenses.list(w.member.userId, w.tripId, { limit: 1, cursor: bad })),
      ).toBe('validation_failed');
    }
  });

  it('runs the same number of queries whatever the ledger holds', async () => {
    const w = await expensesWorld(tdb);
    const counts = [];
    for (const n of [1, 6]) {
      // eslint-disable-next-line no-await-in-loop -- rows go in one by one
      for (let i = 0; i < n; i += 1) await spent(w, '2026-11-12', { itemId: w.hidden });
      const { handle, state } = counted(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      await expensesService(handle).list(w.member.userId, w.tripId, page);
      counts.push(state.queries);
    }
    expect(counts[0]).toBe(counts[1]);
  });
});
