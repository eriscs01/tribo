// @module-tag drop-a
// items.list (Drop A): All types; ?type, ?from&to, ?assignee=me; item_visible; viewers masked; costs per canViewCosts
import { PAGE_LIMIT_MAX, type ItemListQuery } from '@tribo/contract';
import { createItemsService, writePath, type ItemsService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createTrip,
  createUser,
  softDelete,
  type TripRole,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let items: ItemsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  items = createItemsService(tdb.db, writePath(tdb.db), testKeys());
});
afterAll(() => tdb.destroy());

async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

const page = (query: Partial<ItemListQuery> = {}): ItemListQuery => ({
  limit: PAGE_LIMIT_MAX,
  ...query,
});

const ids = async (userId: string, tripId: string, query: Partial<ItemListQuery> = {}) =>
  (await items.list(userId, tripId, page(query))).items.map((i) => i.id);

/** A trip with one member of each role and an outsider. */
async function world() {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  const member = async (role: TripRole) => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, {
      tripId: trip.tripId,
      personId: user.personId,
      role,
    });
    return { ...user, membershipId };
  };
  return {
    trip,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
}

describe('items.list', () => {
  it('lets owner, organizer, member and viewer list the shared items', async () => {
    const w = await world();
    const item = await createItem(tdb.db, {
      tripId: w.trip.tripId,
      ownerMembershipId: w.member.membershipId,
    });
    for (const user of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      expect(await ids(user.userId, w.trip.tripId)).toEqual([item]);
    }
  });

  it('answers not_found outside the trip: an outsider, a removed member, a deleted trip', async () => {
    const w = await world();
    expect(await refusal(items.list(w.outsider.userId, w.trip.tripId, page()))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await refusal(items.list(w.member.userId, w.trip.tripId, page()))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.trip.tripId);
    expect(await refusal(items.list(w.owner.userId, w.trip.tripId, page()))).toBe('not_found');
  });

  it('lists through tribo.item_visible: private and selected items only for who may see them', async () => {
    const w = await world();
    const { tripId } = w.trip;
    const shared = await createItem(tdb.db, { tripId, ownerMembershipId: w.owner.membershipId });
    const mine = await createItem(tdb.db, {
      tripId,
      ownerMembershipId: w.member.membershipId,
      visibility: 'private',
    });
    const selected = await createItem(tdb.db, {
      tripId,
      ownerMembershipId: w.owner.membershipId,
      visibility: 'selected',
      sharedWith: [w.viewer.membershipId],
    });
    const deleted = await createItem(tdb.db, { tripId, ownerMembershipId: w.owner.membershipId });
    await softDelete(tdb.db, 'tribo.items', deleted);
    // Another trip's items never show, even to its own members.
    const other = await createTrip(tdb.db, { owner: w.owner });
    await createItem(tdb.db, { tripId: other.tripId, ownerMembershipId: other.ownerMembershipId });

    expect(await ids(w.owner.userId, tripId)).toEqual([shared, selected]);
    expect(await ids(w.organizer.userId, tripId)).toEqual([shared]);
    expect(await ids(w.member.userId, tripId)).toEqual([shared, mine]);
    expect(await ids(w.viewer.userId, tripId)).toEqual([shared, selected]);
  });

  it('masks costs for a viewer without can_view_costs, and booking refs for everyone', async () => {
    const w = await world();
    const cost = { amountMinor: 450000, currency: 'PHP' };
    await createItem(tdb.db, {
      tripId: w.trip.tripId,
      ownerMembershipId: w.owner.membershipId,
      cost,
    });
    await tdb.db
      .updateTable('tribo.items')
      .set({ booking_ref_enc: Buffer.from('ciphertext'), card_last4_enc: Buffer.from('c') })
      .where('trip_id', '=', w.trip.tripId)
      .execute();
    const first = async (userId: string) =>
      (await items.list(userId, w.trip.tripId, page())).items[0];

    expect(await first(w.member.userId)).toMatchObject({
      cost,
      hasBookingRef: true,
      hasCardLast4: true,
    });
    expect(await first(w.viewer.userId)).toMatchObject({ cost: 'masked', hasBookingRef: true });
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ can_view_costs: true })
      .where('id', '=', w.viewer.membershipId)
      .execute();
    expect(await first(w.viewer.userId)).toMatchObject({ cost });
  });

  it('filters by ?type', async () => {
    const w = await world();
    const { tripId } = w.trip;
    const ownerMembershipId = w.owner.membershipId;
    const hotel = await createItem(tdb.db, { tripId, ownerMembershipId, type: 'lodging' });
    await createItem(tdb.db, { tripId, ownerMembershipId, type: 'meal' });
    expect(await ids(w.member.userId, tripId, { type: 'lodging' })).toEqual([hotel]);
  });

  it('filters by ?from&to: items whose days, in their own zones, overlap the range', async () => {
    const w = await world();
    const { tripId } = w.trip;
    const ownerMembershipId = w.owner.membershipId;
    const stay = await createItem(tdb.db, {
      tripId,
      ownerMembershipId,
      days: { start: '2026-11-11', end: '2026-11-13' },
    });
    const lastDay = await createItem(tdb.db, {
      tripId,
      ownerMembershipId,
      days: { start: '2026-11-14' },
    });
    // 23:30 on the 12th in Manila is 15:30Z, still the 12th; 00:30 on the 13th is the 12th in UTC.
    const lateDinner = await createItem(tdb.db, {
      tripId,
      ownerMembershipId,
      timed: { start: new Date('2026-11-12T15:30:00Z'), tz: 'Asia/Manila' },
    });
    const earlyFlight = await createItem(tdb.db, {
      tripId,
      ownerMembershipId,
      timed: {
        start: new Date('2026-11-12T16:30:00Z'),
        end: new Date('2026-11-12T18:00:00Z'),
        tz: 'Asia/Manila',
      },
    });
    const undated = await createItem(tdb.db, { tripId, ownerMembershipId });

    const user = w.member.userId;
    expect(await ids(user, tripId, { from: '2026-11-12', to: '2026-11-12' })).toEqual([
      stay,
      lateDinner,
    ]);
    expect(await ids(user, tripId, { from: '2026-11-13' })).toEqual([stay, lastDay, earlyFlight]);
    expect(await ids(user, tripId, { to: '2026-11-11' })).toEqual([stay]);
    expect(await ids(user, tripId)).toContain(undated);
  });

  it("filters by ?assignee=me: the caller's assignee rows only", async () => {
    const w = await world();
    const { tripId } = w.trip;
    const ownerMembershipId = w.owner.membershipId;
    const task = await createItem(tdb.db, { tripId, ownerMembershipId, type: 'task' });
    const theirs = await createItem(tdb.db, { tripId, ownerMembershipId, type: 'task' });
    const dinner = await createItem(tdb.db, { tripId, ownerMembershipId, type: 'meal' });
    const me = w.member.membershipId;
    await addAllocation(tdb.db, { tripId, itemId: task, membershipId: me, role: 'assignee' });
    await addAllocation(tdb.db, {
      tripId,
      itemId: theirs,
      membershipId: w.organizer.membershipId,
      role: 'assignee',
    });
    await addAllocation(tdb.db, {
      tripId,
      itemId: dinner,
      membershipId: me,
      role: 'attendee',
      rsvp: 'yes',
    });
    expect(await ids(w.member.userId, tripId, { assignee: 'me' })).toEqual([task]);
  });

  it('pages in the order items were added, and refuses a foreign cursor', async () => {
    const w = await world();
    const { tripId } = w.trip;
    const added = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- insertion order is the list order
      added.push(await createItem(tdb.db, { tripId, ownerMembershipId: w.owner.membershipId }));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
      const result = await items.list(w.member.userId, tripId, page({ limit: 2, cursor }));
      seen.push(...result.items.map((i) => i.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(added);

    const bad = Buffer.from(JSON.stringify(['not-a-uuid'])).toString('base64url');
    expect(await refusal(items.list(w.member.userId, tripId, page({ cursor: bad })))).toBe(
      'validation_failed',
    );
  });
});
