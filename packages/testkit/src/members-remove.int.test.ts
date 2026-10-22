// @module-tag drop-a
// members.remove (Drop A): Remove member (soft delete); ledger rows stay; MCP approval; Also deletes the member's allocations (bumps boardVersion of each item); trip_archived on archived trips (R29); Also soft-deletes the private items the member owns; rejoin undeletes them (R32)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import type { MembersService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createPlaceholder,
  softDelete,
} from './factories.js';
import { inviteWorld, membersService } from './invite-world.js';

let tdb: TestDatabase;
let members: MembersService;
const as = contexts('req-member-remove');

beforeAll(async () => {
  tdb = await createTestDatabase();
  members = membersService(tdb.db);
});
afterAll(() => tdb.destroy());

const membership = (id: string) =>
  tdb.db
    .selectFrom('tribo.memberships')
    .select(['version', 'deleted_at', 'deleted_by'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

const item = (id: string) =>
  tdb.db
    .selectFrom('tribo.items')
    .select(['version', 'board_version', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

const allocationsOf = (membershipId: string) =>
  tdb.db
    .selectFrom('tribo.allocations')
    .select(['item_id', 'role'])
    .where('membership_id', '=', membershipId)
    .execute();

/**
 * The member owns a private item, a shared one and a selected one, is on two boards (one
 * of them on their own private item, which the owner cannot see) and paid an expense.
 */
async function busyWorld() {
  const w = await inviteWorld(tdb);
  const own = (visibility: 'shared' | 'private' | 'selected') =>
    createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      visibility,
      ...(visibility === 'selected' ? { sharedWith: [w.viewer.membershipId] } : {}),
    });
  const privateItem = await own('private');
  const sharedItem = await own('shared');
  const selectedItem = await own('selected');
  const hike = await createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: w.owner.membershipId,
    title: 'Marlboro Hills hike',
  });
  const untouched = await createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: w.owner.membershipId,
  });
  const attend = (itemId: string, membershipId: string) =>
    addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId,
      membershipId,
      role: 'attendee',
      rsvp: 'yes',
    });
  await attend(hike, w.member.membershipId);
  await attend(hike, w.viewer.membershipId);
  await attend(privateItem, w.member.membershipId);
  await attend(untouched, w.viewer.membershipId);
  const { id: expenseId } = await tdb.db
    .insertInto('tribo.expenses')
    .values({
      trip_id: w.tripId,
      category: 'food',
      description: 'Pinikpikan dinner',
      spent_on: '2026-11-12',
      payer_membership_id: w.member.membershipId,
      amount_minor: 120_000,
      currency: 'PHP',
      trip_amount_minor: 120_000,
      split_method: 'equal',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tdb.db
    .insertInto('tribo.expense_shares')
    .values({
      expense_id: expenseId,
      trip_id: w.tripId,
      membership_id: w.member.membershipId,
      share_minor: 120_000,
    })
    .execute();
  return { ...w, privateItem, sharedItem, selectedItem, hike, untouched, expenseId };
}

describe('members.remove', () => {
  it("soft-deletes the membership and keeps the ledger: the member's expense and share stay", async () => {
    const w = await busyWorld();
    await members.remove(as(w.owner), w.tripId, w.member.membershipId, undefined, 1);
    expect(await membership(w.member.membershipId)).toEqual({
      version: 2,
      deleted_at: expect.any(Date) as Date,
      deleted_by: w.owner.userId,
    });
    const listed = await members.list(w.owner.userId, w.tripId, { limit: 50 });
    expect(listed.items.map((m) => m.id)).not.toContain(w.member.membershipId);
    const ledger = await tdb.db
      .selectFrom('tribo.expense_shares')
      .select('membership_id')
      .where('expense_id', '=', w.expenseId)
      .execute();
    expect(ledger).toEqual([{ membership_id: w.member.membershipId }]);
  });

  it("deletes the member's allocations on every board, hidden items included, bumping each one's boardVersion", async () => {
    const w = await busyWorld();
    const ctx = as(w.owner);
    await members.remove(ctx, w.tripId, w.member.membershipId, undefined, 1);
    expect(await allocationsOf(w.member.membershipId)).toEqual([]);
    expect(await allocationsOf(w.viewer.membershipId)).toHaveLength(2);
    expect((await item(w.hike)).board_version).toBe(2);
    expect((await item(w.privateItem)).board_version).toBe(2);
    expect((await item(w.untouched)).board_version).toBe(1);
    const board = await history(tdb, w.hike);
    expect(board.events).toEqual([
      expect.objectContaining({
        action: 'update',
        entity_type: 'item_board',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      }),
    ]);
    expect(board.snapshots).toEqual([
      {
        entity_type: 'item_board',
        version: 2,
        snapshot: {
          allocations: [
            { membershipId: w.viewer.membershipId, unitId: null, role: 'attendee', rsvp: 'yes' },
          ],
        },
      },
    ]);
  });

  it('R32: soft-deletes the private items the member owns, and only those', async () => {
    const w = await busyWorld();
    const ctx = as(w.owner);
    await members.remove(ctx, w.tripId, w.member.membershipId, undefined, 1);
    expect(await item(w.privateItem)).toMatchObject({
      version: 2,
      deleted_at: expect.any(Date) as Date,
    });
    for (const kept of [w.sharedItem, w.selectedItem]) {
      // eslint-disable-next-line no-await-in-loop -- one item at a time
      expect(await item(kept)).toMatchObject({ version: 1, deleted_at: null });
    }
    const { events, snapshots } = await history(tdb, w.privateItem);
    expect(events.map((e) => [e.entity_type, e.action, e.version_after, e.request_id])).toEqual([
      ['item_board', 'update', 2, ctx.requestId],
      ['item', 'delete', 2, ctx.requestId],
    ]);
    expect(snapshots.map((s) => [s.entity_type, s.version])).toEqual([
      ['item', 2],
      ['item_board', 2],
    ]);
  });

  it('refuses organizer, member, viewer with forbidden; lets owner; self (non-owner leaving, G14)', async () => {
    const w = await inviteWorld(tdb);
    for (const who of [w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const code = await refusal(
        members.remove(as(who), w.tripId, w.guest.membershipId, undefined, 1),
      );
      expect(code).toBe('forbidden');
    }
    expect((await membership(w.guest.membershipId)).deleted_at).toBeNull();
    for (const who of [w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- each leaves on their own
      await members.remove(as(who), w.tripId, who.membershipId, undefined, 1);
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      expect(await membership(who.membershipId)).toMatchObject({ deleted_by: who.userId });
    }
    await members.remove(as(w.owner), w.tripId, w.guest.membershipId, undefined, 1);
    expect((await membership(w.guest.membershipId)).deleted_at).not.toBeNull();
  });

  it('keeps the owner in the trip until they hand it over: owner_transfer_required (G14)', async () => {
    const w = await inviteWorld(tdb);
    const code = await refusal(
      members.remove(as(w.owner), w.tripId, w.owner.membershipId, undefined, 1),
    );
    expect(code).toBe('owner_transfer_required');
    expect((await membership(w.owner.membershipId)).deleted_at).toBeNull();
  });

  it('answers not_found to an account outside the trip, and for a membership not active here', async () => {
    const w = await inviteWorld(tdb);
    expect(
      await refusal(members.remove(as(w.outsider), w.tripId, w.member.membershipId, undefined, 1)),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.guest.membershipId);
    expect(
      await refusal(members.remove(as(w.owner), w.tripId, w.guest.membershipId, undefined, 1)),
    ).toBe('not_found');
    // A removed member's own leave is not_found too: they are no longer in the trip.
    await members.remove(as(w.viewer), w.tripId, w.viewer.membershipId, undefined, 1);
    expect(
      await refusal(members.remove(as(w.viewer), w.tripId, w.viewer.membershipId, undefined, 2)),
    ).toBe('not_found');
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await inviteWorld(tdb);
    const remove = (version: number | undefined) =>
      members.remove(as(w.owner), w.tripId, w.member.membershipId, undefined, version);
    expect(await refusal(remove(undefined))).toBe('if_match_required');
    expect(await refusal(remove(7))).toBe('version_conflict');
    expect((await membership(w.member.membershipId)).deleted_at).toBeNull();
    await remove(1);
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await inviteWorld(tdb);
    const ctx = as(w.owner);
    await members.remove(ctx, w.tripId, w.member.membershipId, undefined, 1);
    expect(await history(tdb, w.member.membershipId)).toEqual({
      events: [
        {
          chain_key: `trip:${w.tripId}`,
          action: 'delete',
          entity_type: 'membership',
          version_before: 1,
          version_after: 2,
          request_id: ctx.requestId,
        },
      ],
      snapshots: [
        {
          entity_type: 'membership',
          version: 2,
          snapshot: { personId: w.member.personId, role: 'member', canViewCosts: false },
        },
      ],
    });
  });

  it('answers trip_archived where operations.csv says so', async () => {
    const w = await inviteWorld(tdb);
    await archive(tdb, w.tripId);
    expect(
      await refusal(members.remove(as(w.owner), w.tripId, w.member.membershipId, undefined, 1)),
    ).toBe('trip_archived');
  });

  it('R32: re-adding a removed placeholder undeletes the private items the removal took, and only those', async () => {
    const w = await inviteWorld(tdb);
    const guestId = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    const guest = await addMember(tdb.db, { tripId: w.tripId, personId: guestId, role: 'member' });
    const removedWith = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: guest,
      visibility: 'private',
    });
    const deletedBefore = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: guest,
      visibility: 'private',
    });
    await softDelete(tdb.db, 'tribo.items', deletedBefore);
    await members.remove(as(w.owner), w.tripId, guest, undefined, 1);
    const ctx = as(w.owner);
    const back = await members.add(ctx, w.tripId, {
      personId: encodeTypeId(ID_PREFIX.person, guestId),
    });
    expect(back).toMatchObject({ id: guest, version: 3 });
    expect(await item(removedWith)).toMatchObject({ version: 3, deleted_at: null });
    expect((await item(deletedBefore)).deleted_at).not.toBeNull();
    const { events, snapshots } = await history(tdb, removedWith);
    expect(events.at(-1)).toMatchObject({
      action: 'restore',
      entity_type: 'item',
      version_after: 3,
      request_id: ctx.requestId,
    });
    expect(snapshots.at(-1)).toMatchObject({ entity_type: 'item', version: 3 });
  });
});
