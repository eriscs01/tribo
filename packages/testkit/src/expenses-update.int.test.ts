// @module-tag drop-b
// expenses.update (Drop B): Edit expense; shares recomputed; Same FX rule and share-sum check as create; trip_archived on archived trips (R29)
// Through the expenses service and the real trips, items and audit modules: who may edit an
// expense, when its shares are refrozen and how, what a patch may say, and that each edit
// is versioned and recorded.
import type { ExpenseRecord, ExpensesService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createUser, softDelete } from './factories.js';
import {
  dinner,
  expenseRows,
  expensesService,
  expensesWorld,
  itm,
  mem,
  type ExpensesWorld,
} from './expenses-world.js';

let tdb: TestDatabase;
let expenses: ExpensesService;
const as = contexts('expenses-update');

beforeAll(async () => {
  tdb = await createTestDatabase();
  expenses = expensesService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

/** The member's dinner of PHP 1,000.00, split equally among owner, member and organizer. */
const memberDinner = (w: ExpensesWorld, overrides: Record<string, unknown> = {}) =>
  expenses.create(as(w.member), w.tripId, dinner(w, overrides));

const amounts = (e: ExpenseRecord) =>
  e.shares.map((s) => [s.membershipId, (s.amount as { amountMinor: number }).amountMinor]);

const sorted = (...ids: string[]) => [...ids].sort();

describe('expenses.update', () => {
  it('edits the description, category, day and item under If-Match, keeping the shares frozen', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const edited = await expenses.update(
      as(w.member),
      created.id,
      {
        description: 'Dinner and drinks',
        category: 'drinks',
        spentOn: '2026-11-13',
        itemId: itm(w.lodging),
      },
      1,
    );
    expect(edited).toMatchObject({
      description: 'Dinner and drinks',
      category: 'drinks',
      spentOn: '2026-11-13',
      itemId: w.lodging,
      version: 2,
    });
    expect(edited.shares).toEqual(created.shares);
    const detached = await expenses.update(as(w.member), created.id, { itemId: null }, 2);
    expect(detached).toMatchObject({ itemId: null, version: 3 });
  });

  it('refreezes an equal split among the same members when the amount changes', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const edited = await expenses.update(
      as(w.member),
      created.id,
      { amount: { amountMinor: 100_001, currency: 'PHP' } },
      1,
    );
    const [first, second, third] = sorted(
      w.owner.membershipId,
      w.member.membershipId,
      w.organizer.membershipId,
    );
    expect(edited.tripAmount).toEqual({ amountMinor: 100_001, currency: 'PHP' });
    expect(amounts(edited)).toEqual([
      [first, 33_334],
      [second, 33_334],
      [third, 33_333],
    ]);
    const { shares } = await expenseRows(tdb, created.id);
    expect(shares.map((s) => Number(s.share_minor))).toEqual([33_334, 33_334, 33_333]);
  });

  it('replaces the split, equal to itemised and back, among other members', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const itemised = await expenses.update(
      as(w.member),
      created.id,
      {
        split: {
          method: 'itemised',
          shares: [
            { membershipId: mem(w.viewer.membershipId), amountMinor: 25_000 },
            { membershipId: mem(w.placeholder), amountMinor: 75_000 },
          ],
        },
      },
      1,
    );
    expect(itemised.splitMethod).toBe('itemised');
    expect(Object.fromEntries(amounts(itemised))).toEqual({
      [w.viewer.membershipId]: 25_000,
      [w.placeholder]: 75_000,
    });
    const equal = await expenses.update(
      as(w.member),
      created.id,
      {
        amount: { amountMinor: 3, currency: 'PHP' },
        split: {
          method: 'equal',
          membershipIds: [mem(w.member.membershipId), mem(w.viewer.membershipId)],
        },
      },
      2,
    );
    expect(equal.splitMethod).toBe('equal');
    expect(equal.shares.map((s) => s.membershipId)).toEqual(
      sorted(w.member.membershipId, w.viewer.membershipId),
    );
    expect(amounts(equal).map(([, a]) => a)).toEqual([2, 1]);
    expect((await expenseRows(tdb, created.id)).shares).toHaveLength(2);
  });

  it('refuses a new amount that itemised shares no longer sum to, unless a new split comes with it', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w, {
      split: {
        method: 'itemised',
        shares: [
          { membershipId: mem(w.member.membershipId), amountMinor: 60_000 },
          { membershipId: mem(w.owner.membershipId), amountMinor: 40_000 },
        ],
      },
    });
    const bigger = { amount: { amountMinor: 120_000, currency: 'PHP' } };
    expect(await refusal(expenses.update(as(w.member), created.id, bigger, 1))).toBe(
      'validation_failed',
    );
    const edited = await expenses.update(
      as(w.member),
      created.id,
      {
        ...bigger,
        split: {
          method: 'itemised',
          shares: [
            { membershipId: mem(w.member.membershipId), amountMinor: 70_000 },
            { membershipId: mem(w.owner.membershipId), amountMinor: 50_000 },
          ],
        },
      },
      1,
    );
    expect(edited.tripAmount).toEqual({ amountMinor: 120_000, currency: 'PHP' });
  });

  it('lets the owner and organizers edit any expense and a member their own; refuses others and viewers', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    await expenses.update(as(w.owner), created.id, { description: 'a' }, 1);
    await expenses.update(as(w.organizer), created.id, { description: 'b' }, 2);
    await expenses.update(as(w.member), created.id, { description: 'c' }, 3);
    expect(await refusal(expenses.update(as(w.other), created.id, { description: 'd' }, 4))).toBe(
      'forbidden',
    );
    expect(await refusal(expenses.update(as(w.viewer), created.id, { description: 'd' }, 4))).toBe(
      'forbidden',
    );
    expect((await expenseRows(tdb, created.id)).expense?.description).toBe('c');
  });

  it('makes an expense a member’s own by who paid it, not by who recorded it; never a viewer’s', async () => {
    const w = await expensesWorld(tdb);
    const paidByOther = await memberDinner(w, { payerMembershipId: mem(w.other.membershipId) });
    expect(
      await refusal(expenses.update(as(w.member), paidByOther.id, { description: 'x' }, 1)),
    ).toBe('forbidden');
    await expenses.update(as(w.other), paidByOther.id, { description: 'mine' }, 1);
    const paidByViewer = await memberDinner(w, { payerMembershipId: mem(w.viewer.membershipId) });
    expect(
      await refusal(expenses.update(as(w.viewer), paidByViewer.id, { description: 'x' }, 1)),
    ).toBe('forbidden');
  });

  it('answers not_found outside the trip, to a removed member, on a deleted trip and once voided', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    expect(
      await refusal(expenses.update(as(w.outsider), created.id, { description: 'x' }, 1)),
    ).toBe('not_found');
    const voided = await memberDinner(w);
    await softDelete(tdb.db, 'tribo.expenses', voided.id);
    expect(await refusal(expenses.update(as(w.member), voided.id, { description: 'x' }, 1))).toBe(
      'not_found',
    );
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await refusal(expenses.update(as(w.member), created.id, { description: 'x' }, 1))).toBe(
      'not_found',
    );
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(expenses.update(as(w.owner), created.id, { description: 'x' }, 1))).toBe(
      'not_found',
    );
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    for (const patch of [
      { tripAmountMinor: 5 },
      { category: 'Food!' },
      { description: '' },
      { amount: { amountMinor: 0, currency: 'PHP' } },
      { split: { method: 'equal', membershipIds: [] } },
      { payerMembershipId: w.member.membershipId },
      { itemId: itm(w.hidden) },
      { payerMembershipId: mem(w.elsewhere.ownerMembershipId) },
      { split: { method: 'equal', membershipIds: [mem(w.elsewhere.ownerMembershipId)] } },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      expect(await refusal(expenses.update(as(w.member), created.id, patch, 1))).toBe(
        'validation_failed',
      );
    }
    expect((await expenseRows(tdb, created.id)).expense?.version).toBe(1);
  });

  it('refreezes shares only among active members: a kept split with a member removed needs a new one', async () => {
    const w = await expensesWorld(tdb);
    const leaving = await createUser(tdb.db);
    const leaver = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaving.personId,
      role: 'member',
    });
    const created = await memberDinner(w, {
      split: { method: 'equal', membershipIds: [mem(w.member.membershipId), mem(leaver)] },
    });
    await softDelete(tdb.db, 'tribo.memberships', leaver);
    // Nothing about the money changes: the frozen shares stay, the removed member's included.
    const renamed = await expenses.update(
      as(w.member),
      created.id,
      { description: 'Before they left' },
      1,
    );
    expect(renamed.shares.map((s) => s.membershipId)).toContain(leaver);
    expect(
      await refusal(
        expenses.update(
          as(w.member),
          created.id,
          { amount: { amountMinor: 90_000, currency: 'PHP' } },
          2,
        ),
      ),
    ).toBe('validation_failed');
  });

  it('keeps a link to an item the caller cannot see when they send null; one they see replaces it', async () => {
    const w = await expensesWorld(tdb);
    const created = await expenses.create(
      as(w.other),
      w.tripId,
      dinner(w, { payerMembershipId: mem(w.other.membershipId), itemId: itm(w.hidden) }),
    );
    const kept = await expenses.update(
      as(w.organizer),
      created.id,
      { itemId: null, description: 'x' },
      1,
    );
    expect(kept.itemId).toBeNull();
    expect((await expenseRows(tdb, created.id)).expense?.item_id).toBe(w.hidden);
    const relinked = await expenses.update(
      as(w.organizer),
      created.id,
      { itemId: itm(w.lodging) },
      2,
    );
    expect(relinked.itemId).toBe(w.lodging);
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    expect(
      await refusal(expenses.update(as(w.member), created.id, { description: 'x' }, undefined)),
    ).toBe('if_match_required');
    expect(await refusal(expenses.update(as(w.member), created.id, { description: 'x' }, 7))).toBe(
      'version_conflict',
    );
    expect((await expenseRows(tdb, created.id)).expense?.version).toBe(1);
  });

  it('answers trip_archived on an archived trip', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    await archive(tdb, w.tripId);
    expect(await refusal(expenses.update(as(w.owner), created.id, { description: 'x' }, 1))).toBe(
      'trip_archived',
    );
  });

  it('Trip currency only: fx_rate = 1; FX entry follows after the trip.', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    for (const patch of [{ amount: { amountMinor: 5_000, currency: 'JPY' } }, { fxRate: '0.37' }]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      expect(await refusal(expenses.update(as(w.member), created.id, patch, 1))).toBe(
        'validation_failed',
      );
    }
  });

  it('Splits are equal or itemised only; weight follows after the trip.', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const weighted = {
      split: {
        method: 'weight',
        shares: [{ membershipId: mem(w.member.membershipId), weight: 1 }],
      },
    };
    expect(await refusal(expenses.update(as(w.member), created.id, weighted, 1))).toBe(
      'validation_failed',
    );
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const ctx: RequestContext = as(w.organizer);
    const edited = await expenses.update(
      ctx,
      created.id,
      { amount: { amountMinor: 3_000, currency: 'PHP' } },
      1,
    );
    const { events, snapshots } = await history(tdb, created.id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'update',
      entity_type: 'expense',
      version_before: 1,
      version_after: 2,
      request_id: ctx.requestId,
    });
    expect(snapshots.at(-1)).toMatchObject({
      entity_type: 'expense',
      version: 2,
      snapshot: {
        amountMinor: 3_000,
        tripAmountMinor: 3_000,
        shares: edited.shares.map((s) => ({
          membershipId: s.membershipId,
          shareMinor: (s.amount as { amountMinor: number }).amountMinor,
        })),
      },
    });
  });
});
