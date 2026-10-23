// @module-tag drop-b
// expenses.create (Drop B): Record expense: payer, amount, FX, members included and split equal|weight|itemised (one share per included member); Shares frozen, largest remainder; tripAmountMinor = max(1, round half-up(amount × fxRate × 10^(e_trip − e_orig))), fxRate per major unit, static ISO 4217 exponent table (R8); write path guarantees shares sum to tripAmountMinor (R11, rule 2); trip_archived on archived trips (R29)
// Through the expenses service and the real trips, items and audit modules: who may record
// an expense, what a body may say, how its shares are frozen, and that each one is recorded.
// The Idempotency-Key's replay over HTTP is in apps/server/src/expenses.int.test.ts.
import type { ExpensesService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createItem, createUser, softDelete } from './factories.js';
import {
  dinner,
  expenseCount,
  expenseRows,
  expensesService,
  expensesWorld,
  itm,
  mem,
} from './expenses-world.js';

let tdb: TestDatabase;
let expenses: ExpensesService;
const as = contexts('expenses-create');

beforeAll(async () => {
  tdb = await createTestDatabase();
  expenses = expensesService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

/** The ApiError a call refused with, whole: its code and the errors it names. */
async function problem(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return JSON.parse(
    JSON.stringify({
      code: (error as { code?: unknown }).code,
      ...(error as { extra?: object }).extra,
    }),
  ) as unknown;
}

const sorted = (...ids: string[]) => [...ids].sort();

describe('expenses.create', () => {
  it('freezes an equal split by largest remainder, the leftover unit to the earliest member', async () => {
    const w = await expensesWorld(tdb);
    const created = await expenses.create(as(w.member), w.tripId, dinner(w));
    const [first, second, third] = sorted(
      w.owner.membershipId,
      w.member.membershipId,
      w.organizer.membershipId,
    );
    expect(created).toMatchObject({
      tripId: w.tripId,
      itemId: null,
      category: 'food',
      description: 'Dinner at Coco Grove',
      spentOn: '2026-11-12',
      payerMembershipId: w.member.membershipId,
      amount: { amountMinor: 100_000, currency: 'PHP' },
      fxRate: '1',
      tripAmount: { amountMinor: 100_000, currency: 'PHP' },
      splitMethod: 'equal',
      shares: [
        { membershipId: first, amount: { amountMinor: 33_334, currency: 'PHP' } },
        { membershipId: second, amount: { amountMinor: 33_333, currency: 'PHP' } },
        { membershipId: third, amount: { amountMinor: 33_333, currency: 'PHP' } },
      ],
      version: 1,
    });
    const { expense, shares } = await expenseRows(tdb, created.id);
    expect(expense).toMatchObject({
      amount_minor: '100000',
      currency: 'PHP',
      trip_amount_minor: '100000',
      split_method: 'equal',
      created_by: w.member.userId,
    });
    expect(Number(expense?.fx_rate)).toBe(1);
    expect(shares.map((s) => Number(s.share_minor))).toEqual([33_334, 33_333, 33_333]);
  });

  it('keeps an itemised split as named, sorted by membership', async () => {
    const w = await expensesWorld(tdb);
    const created = await expenses.create(
      as(w.owner),
      w.tripId,
      dinner(w, {
        payerMembershipId: mem(w.owner.membershipId),
        split: {
          method: 'itemised',
          shares: [
            { membershipId: mem(w.viewer.membershipId), amountMinor: 70_000 },
            { membershipId: mem(w.placeholder), amountMinor: 30_000 },
          ],
        },
      }),
    );
    expect(created.splitMethod).toBe('itemised');
    const byMember = Object.fromEntries(created.shares.map((s) => [s.membershipId, s.amount]));
    expect(byMember).toEqual({
      [w.viewer.membershipId]: { amountMinor: 70_000, currency: 'PHP' },
      [w.placeholder]: { amountMinor: 30_000, currency: 'PHP' },
    });
    expect(created.shares.map((s) => s.membershipId)).toEqual(
      sorted(w.viewer.membershipId, w.placeholder),
    );
  });

  it('refuses amounts that do not sum to the amount with validation_failed at /split/shares', async () => {
    const w = await expensesWorld(tdb);
    const body = dinner(w, {
      split: {
        method: 'itemised',
        shares: [
          { membershipId: mem(w.member.membershipId), amountMinor: 60_000 },
          { membershipId: mem(w.owner.membershipId), amountMinor: 40_001 },
        ],
      },
    });
    expect(await problem(expenses.create(as(w.member), w.tripId, body))).toEqual({
      code: 'validation_failed',
      errors: [{ path: '/split/shares', message: 'the shares must sum to the amount' }],
    });
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('lets the owner, an organizer and a member record one; refuses a viewer with forbidden', async () => {
    const w = await expensesWorld(tdb);
    for (const who of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      await expenses.create(as(who), w.tripId, dinner(w));
    }
    expect(await refusal(expenses.create(as(w.viewer), w.tripId, dinner(w)))).toBe('forbidden');
    expect(await expenseCount(tdb, w.tripId)).toBe(3);
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await expensesWorld(tdb);
    expect(await refusal(expenses.create(as(w.outsider), w.tripId, dinner(w)))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(expenses.create(as(w.other), w.tripId, dinner(w)))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(expenses.create(as(w.owner), w.tripId, dinner(w)))).toBe('not_found');
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await expensesWorld(tdb);
    const bodies = [
      {},
      dinner(w, { amount: { amountMinor: 0, currency: 'PHP' } }),
      dinner(w, { amount: { amountMinor: 12.5, currency: 'PHP' } }),
      dinner(w, { category: 'Food & drink' }),
      dinner(w, { description: '   ' }),
      dinner(w, { description: 'x'.repeat(301) }),
      dinner(w, { spentOn: '12/11/2026' }),
      dinner(w, { payerMembershipId: w.member.membershipId }),
      dinner(w, { split: { method: 'equal', membershipIds: [] } }),
      dinner(w, {
        split: {
          method: 'equal',
          membershipIds: [mem(w.member.membershipId), mem(w.member.membershipId)],
        },
      }),
      dinner(w, {
        split: {
          method: 'itemised',
          shares: [{ membershipId: mem(w.member.membershipId), amountMinor: -1 }],
        },
      }),
      dinner(w, { tripAmountMinor: 100_000 }),
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      expect(await refusal(expenses.create(as(w.member), w.tripId, body))).toBe(
        'validation_failed',
      );
    }
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('Trip currency only: fx_rate = 1; FX entry follows after the trip.', async () => {
    const w = await expensesWorld(tdb);
    expect(
      await problem(
        expenses.create(
          as(w.member),
          w.tripId,
          dinner(w, { amount: { amountMinor: 5_000, currency: 'JPY' } }),
        ),
      ),
    ).toEqual({
      code: 'validation_failed',
      errors: [{ path: '/amount/currency', message: 'expenses are in the trip currency' }],
    });
    for (const fx of [{ fxRate: '0.37' }, { fxRate: '1' }, { fxDate: '2026-11-12' }]) {
      expect(
        // eslint-disable-next-line no-await-in-loop -- one write at a time
        await refusal(expenses.create(as(w.member), w.tripId, dinner(w, fx))),
      ).toBe('validation_failed');
    }
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('Splits are equal or itemised only; weight follows after the trip.', async () => {
    const w = await expensesWorld(tdb);
    const weighted = dinner(w, {
      split: {
        method: 'weight',
        shares: [{ membershipId: mem(w.member.membershipId), weight: 2 }],
      },
    });
    const answer = (await problem(expenses.create(as(w.member), w.tripId, weighted))) as {
      code: string;
      errors: { path: string }[];
    };
    expect(answer.code).toBe('validation_failed');
    expect(answer.errors.map((e) => e.path)).toEqual(['/split/method']);
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('takes placeholders and viewers as payer or sharer: every active membership of the trip', async () => {
    const w = await expensesWorld(tdb);
    const created = await expenses.create(
      as(w.organizer),
      w.tripId,
      dinner(w, {
        payerMembershipId: mem(w.placeholder),
        split: { method: 'equal', membershipIds: [mem(w.placeholder), mem(w.viewer.membershipId)] },
      }),
    );
    expect(created.payerMembershipId).toBe(w.placeholder);
    expect(created.shares.map((s) => s.amount)).toEqual([
      { amountMinor: 50_000, currency: 'PHP' },
      { amountMinor: 50_000, currency: 'PHP' },
    ]);
  });

  it('refuses a foreign, removed or unknown membership alike, as payer or as sharer', async () => {
    const w = await expensesWorld(tdb);
    const removed = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: (await createUser(tdb.db)).personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', removed);
    const unknown = '0192f000-0000-7000-8000-000000000000';
    const answers = {
      payer: new Set<string>(),
      equal: new Set<string>(),
      itemised: new Set<string>(),
    };
    for (const id of [w.elsewhere.ownerMembershipId, removed, unknown]) {
      const payer = dinner(w, { payerMembershipId: mem(id) });
      const equal = dinner(w, {
        split: { method: 'equal', membershipIds: [mem(w.member.membershipId), mem(id)] },
      });
      const itemised = dinner(w, {
        split: {
          method: 'itemised',
          shares: [
            { membershipId: mem(w.member.membershipId), amountMinor: 50_000 },
            { membershipId: mem(id), amountMinor: 50_000 },
          ],
        },
      });
      /* eslint-disable no-await-in-loop -- one write at a time */
      answers.payer.add(
        JSON.stringify(await problem(expenses.create(as(w.member), w.tripId, payer))),
      );
      answers.equal.add(
        JSON.stringify(await problem(expenses.create(as(w.member), w.tripId, equal))),
      );
      answers.itemised.add(
        JSON.stringify(await problem(expenses.create(as(w.member), w.tripId, itemised))),
      );
      /* eslint-enable no-await-in-loop */
    }
    expect([...answers.payer]).toEqual([
      JSON.stringify({
        code: 'validation_failed',
        errors: [{ path: '/payerMembershipId', message: 'no such member in this trip' }],
      }),
    ]);
    expect([...answers.equal]).toEqual([
      JSON.stringify({
        code: 'validation_failed',
        errors: [{ path: '/split/membershipIds', message: 'no such member in this trip' }],
      }),
    ]);
    expect([...answers.itemised]).toEqual([
      JSON.stringify({
        code: 'validation_failed',
        errors: [{ path: '/split/shares', message: 'no such member in this trip' }],
      }),
    ]);
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
    expect(await expenseCount(tdb, w.elsewhere.tripId)).toBe(0);
  });

  it('links an item the caller sees; refuses a hidden, foreign, deleted or unknown one alike', async () => {
    const w = await expensesWorld(tdb);
    const linked = await expenses.create(
      as(w.member),
      w.tripId,
      dinner(w, { itemId: itm(w.lodging) }),
    );
    expect(linked.itemId).toBe(w.lodging);

    const foreign = await createItem(tdb.db, {
      tripId: w.elsewhere.tripId,
      ownerMembershipId: w.elsewhere.ownerMembershipId,
    });
    const gone = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
    });
    await softDelete(tdb.db, 'tribo.items', gone);
    const unknown = '0192f000-0000-7000-8000-000000000001';
    for (const itemId of [w.hidden, foreign, gone, unknown]) {
      expect(
        // eslint-disable-next-line no-await-in-loop -- one write at a time
        await problem(expenses.create(as(w.member), w.tripId, dinner(w, { itemId: itm(itemId) }))),
      ).toEqual({
        code: 'validation_failed',
        errors: [{ path: '/itemId', message: 'no such item in this trip' }],
      });
    }
    expect(await expenseCount(tdb, w.tripId)).toBe(1);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await expensesWorld(tdb);
    await archive(tdb, w.tripId);
    expect(await refusal(expenses.create(as(w.owner), w.tripId, dinner(w)))).toBe('trip_archived');
    expect(await expenseCount(tdb, w.tripId)).toBe(0);
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await expensesWorld(tdb);
    const ctx: RequestContext = as(w.member);
    const created = await expenses.create(ctx, w.tripId, dinner(w));
    const { events, snapshots } = await history(tdb, created.id);
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'create',
        entity_type: 'expense',
        version_before: null,
        version_after: 1,
        request_id: ctx.requestId,
      },
    ]);
    expect(snapshots).toEqual([
      {
        entity_type: 'expense',
        version: 1,
        snapshot: {
          tripId: w.tripId,
          itemId: null,
          category: 'food',
          description: 'Dinner at Coco Grove',
          spentOn: '2026-11-12',
          payerMembershipId: w.member.membershipId,
          amountMinor: 100_000,
          currency: 'PHP',
          fxRate: '1',
          tripAmountMinor: 100_000,
          splitMethod: 'equal',
          shares: created.shares.map((s) => ({
            membershipId: s.membershipId,
            shareMinor: (s.amount as { amountMinor: number }).amountMinor,
          })),
        },
      },
    ]);
  });

  it('Honours Idempotency-Key: 24 h per caller, the same key with a different body is idempotency_key_reused.', async () => {
    const w = await expensesWorld(tdb);
    const keyed = (body: unknown): Promise<unknown> =>
      expenses.create(
        {
          ...as(w.member),
          idempotency: {
            caller: `user:${w.member.userId}`,
            key: 'dinner-1',
            operationId: 'expenses.create',
          },
        },
        w.tripId,
        body,
      );
    await keyed(dinner(w));
    expect(await refusal(keyed(dinner(w, { description: 'Lunch' })))).toBe(
      'idempotency_key_reused',
    );
    expect(await expenseCount(tdb, w.tripId)).toBe(1);
  });
});
