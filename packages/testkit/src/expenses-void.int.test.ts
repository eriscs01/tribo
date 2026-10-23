// @module-tag drop-b
// expenses.void (Drop B): Void (soft delete, audited); trip_archived on archived trips (R29)
// Through the expenses service and the real trips and audit modules: who may void an
// expense, that a voided one leaves the ledger and my share while its frozen shares stay
// for restore, and that the void is versioned and recorded.
import { memberShare, moneyRecorded, type ExpensesService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { softDelete } from './factories.js';
import {
  dinner,
  expenseRows,
  expensesService,
  expensesWorld,
  mem,
  type ExpensesWorld,
} from './expenses-world.js';

let tdb: TestDatabase;
let expenses: ExpensesService;
const as = contexts('expenses-void');

beforeAll(async () => {
  tdb = await createTestDatabase();
  expenses = expensesService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

const memberDinner = (w: ExpensesWorld, overrides: Record<string, unknown> = {}) =>
  expenses.create(as(w.member), w.tripId, dinner(w, overrides));

describe('expenses.void', () => {
  it('voids under If-Match: gone from the ledger and my share, its frozen shares kept for restore', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const kept = await memberDinner(w);
    const before = await memberShare(tdb.db, w.tripId, w.member.membershipId);
    await expenses.void(as(w.member), created.id, undefined, 1);

    const { expense, shares } = await expenseRows(tdb, created.id);
    expect(expense?.deleted_at).not.toBeNull();
    expect(expense).toMatchObject({ version: 2, deleted_by: w.member.userId });
    expect(shares).toHaveLength(3);
    expect(await refusal(expenses.get(w.member.userId, created.id))).toBe('not_found');
    expect(
      (await expenses.list(w.member.userId, w.tripId, { limit: 50 })).items.map((e) => e.id),
    ).toEqual([kept.id]);
    expect(await memberShare(tdb.db, w.tripId, w.member.membershipId)).toBe(before - 33_333);
    // The currency stays locked: a voided expense comes back with its amounts on restore (R9).
    expect(await moneyRecorded(tdb.db, w.tripId)).toBe(true);
  });

  it('lets the owner and organizers void any expense and a member the ones they paid; refuses others and viewers', async () => {
    const w = await expensesWorld(tdb);
    const byOwner = await memberDinner(w);
    const byOrganizer = await memberDinner(w);
    const byMember = await memberDinner(w);
    await expenses.void(as(w.owner), byOwner.id, undefined, 1);
    await expenses.void(as(w.organizer), byOrganizer.id, undefined, 1);
    expect(await refusal(expenses.void(as(w.other), byMember.id, undefined, 1))).toBe('forbidden');
    expect(await refusal(expenses.void(as(w.viewer), byMember.id, undefined, 1))).toBe('forbidden');
    const paidByViewer = await memberDinner(w, { payerMembershipId: mem(w.viewer.membershipId) });
    expect(await refusal(expenses.void(as(w.viewer), paidByViewer.id, undefined, 1))).toBe(
      'forbidden',
    );
    await expenses.void(as(w.member), byMember.id, undefined, 1);
  });

  it('answers not_found outside the trip, once voided, to a removed member and on a deleted trip', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    expect(await refusal(expenses.void(as(w.outsider), created.id, undefined, 1))).toBe(
      'not_found',
    );
    const voided = await memberDinner(w);
    await expenses.void(as(w.member), voided.id, undefined, 1);
    expect(await refusal(expenses.void(as(w.member), voided.id, undefined, 2))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await refusal(expenses.void(as(w.member), created.id, undefined, 1))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(expenses.void(as(w.owner), created.id, undefined, 1))).toBe('not_found');
  });

  it('takes no body', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    expect(await refusal(expenses.void(as(w.member), created.id, { reason: 'x' }, 1))).toBe(
      'validation_failed',
    );
    expect((await expenseRows(tdb, created.id)).expense?.deleted_at).toBeNull();
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    expect(await refusal(expenses.void(as(w.member), created.id, undefined, undefined))).toBe(
      'if_match_required',
    );
    expect(await refusal(expenses.void(as(w.member), created.id, undefined, 9))).toBe(
      'version_conflict',
    );
    expect((await expenseRows(tdb, created.id)).expense?.deleted_at).toBeNull();
  });

  it('answers trip_archived on an archived trip', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    await archive(tdb, w.tripId);
    expect(await refusal(expenses.void(as(w.owner), created.id, undefined, 1))).toBe(
      'trip_archived',
    );
    expect((await expenseRows(tdb, created.id)).expense?.deleted_at).toBeNull();
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await expensesWorld(tdb);
    const created = await memberDinner(w);
    const ctx: RequestContext = as(w.organizer);
    await expenses.void(ctx, created.id, undefined, 1);
    const { events, snapshots } = await history(tdb, created.id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'delete',
      entity_type: 'expense',
      version_before: 1,
      version_after: 2,
      request_id: ctx.requestId,
    });
    // The expense as it was: restore (1b) copies this snapshot forward.
    expect(snapshots.at(-1)).toEqual({ ...snapshots[0], version: 2 });
  });
});
