// @module-tag drop-a
// items.rsvp (Drop A): Set caller's own RSVP yes|no|maybe; Item lock + boardVersion bump (item version untouched); touches only caller's attendee row; trip_archived on archived trips (R29)
import { createItemsService, writePath, type ItemsService } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createTrip,
  createUser,
  type TripRole,
  type UserFixture,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let items: ItemsService;
let n = 0;
const as = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `items-rsvp-${String(n)}`, surface: 'web', userId: user.userId };
};

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

/** A trip with one member of each role, a second member and an outsider; a shared dinner. */
async function world() {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole) => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  const w = {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
  const itemId = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.owner.membershipId,
    type: 'meal',
    title: 'Welcome dinner',
  });
  return { ...w, itemId };
}

const board = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.allocations')
    .select(['membership_id', 'role', 'rsvp'])
    .where('item_id', '=', itemId)
    .orderBy('membership_id')
    .orderBy('role')
    .execute();

const counters = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.items')
    .select(['version', 'board_version'])
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();

describe('items.rsvp', () => {
  it("records the caller's answer as their attendee row and bumps board_version only", async () => {
    const w = await world();
    const answer = await items.rsvp(as(w.member), w.itemId, { rsvp: 'yes' });
    expect(answer).toEqual({
      itemId: w.itemId,
      membershipId: w.member.membershipId,
      rsvp: 'yes',
      boardVersion: 2,
    });
    expect(await board(w.itemId)).toEqual([
      { membership_id: w.member.membershipId, role: 'attendee', rsvp: 'yes' },
    ]);
    expect(await counters(w.itemId)).toEqual({ version: 1, board_version: 2 });
  });

  it('lets owner, organizer and member answer; refuses a viewer with forbidden', async () => {
    const w = await world();
    for (const user of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      await expect(items.rsvp(as(user), w.itemId, { rsvp: 'maybe' })).resolves.toMatchObject({
        membershipId: user.membershipId,
      });
    }
    expect(await refusal(items.rsvp(as(w.viewer), w.itemId, { rsvp: 'yes' }))).toBe('forbidden');
    expect(await board(w.itemId)).toHaveLength(3);
  });

  it('answers not_found outside the trip and for an item the caller cannot see', async () => {
    const w = await world();
    expect(await refusal(items.rsvp(as(w.outsider), w.itemId, { rsvp: 'yes' }))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
    });
    expect(await refusal(items.rsvp(as(w.member), secret, { rsvp: 'yes' }))).toBe('not_found');
  });

  it("replaces only the caller's attendee row: others' answers and the caller's other roles stay", async () => {
    const w = await world();
    const { tripId, itemId } = w;
    await addAllocation(tdb.db, {
      tripId,
      itemId,
      membershipId: w.other.membershipId,
      role: 'attendee',
      rsvp: 'no',
    });
    await addAllocation(tdb.db, {
      tripId,
      itemId,
      membershipId: w.member.membershipId,
      role: 'attendee',
      rsvp: 'pending',
    });
    await addAllocation(tdb.db, {
      tripId,
      itemId,
      membershipId: w.member.membershipId,
      role: 'assignee',
    });
    await items.rsvp(as(w.member), itemId, { rsvp: 'maybe' });
    await items.rsvp(as(w.member), itemId, { rsvp: 'yes' });
    const rows = await board(itemId);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { membership_id: w.other.membershipId, role: 'attendee', rsvp: 'no' },
        { membership_id: w.member.membershipId, role: 'attendee', rsvp: 'yes' },
        { membership_id: w.member.membershipId, role: 'assignee', rsvp: null },
      ]),
    );
    expect(await counters(itemId)).toEqual({ version: 1, board_version: 3 });
  });

  it('takes no If-Match, and never makes a concurrent item edit conflict (R26)', async () => {
    const w = await world();
    await items.rsvp(as(w.member), w.itemId, { rsvp: 'yes' });
    // The owner read version 1 before the RSVP; their edit still applies.
    await expect(
      items.update(as(w.owner), w.itemId, { title: 'Welcome dinner, 7pm' }, 1),
    ).resolves.toMatchObject({ version: 2, boardVersion: 2 });
  });

  it('locks the item, so concurrent answers each bump board_version once', async () => {
    const w = await world();
    await Promise.all([
      items.rsvp(as(w.member), w.itemId, { rsvp: 'yes' }),
      items.rsvp(as(w.other), w.itemId, { rsvp: 'no' }),
      items.rsvp(as(w.organizer), w.itemId, { rsvp: 'maybe' }),
    ]);
    expect(await counters(w.itemId)).toEqual({ version: 1, board_version: 4 });
    expect(await board(w.itemId)).toHaveLength(3);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await world();
    for (const body of [{}, { rsvp: 'pending' }, { rsvp: 'yes', role: 'driver' }, null]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(items.rsvp(as(w.member), w.itemId, body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await board(w.itemId)).toEqual([]);
    expect(await counters(w.itemId)).toEqual({ version: 1, board_version: 1 });
  });

  it('records an item_board audit event and snapshot in the one transaction', async () => {
    const w = await world();
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.itemId,
      membershipId: w.other.membershipId,
      role: 'attendee',
      rsvp: 'no',
    });
    await items.rsvp(as(w.member), w.itemId, { rsvp: 'yes' });
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'version_before', 'version_after'])
      .where('entity_id', '=', w.itemId)
      .execute();
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'item_board',
        version_before: 1,
        version_after: 2,
      },
    ]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'snapshot'])
      .where('entity_id', '=', w.itemId)
      .executeTakeFirstOrThrow();
    const allocations = [
      { membershipId: w.member.membershipId, unitId: null, role: 'attendee', rsvp: 'yes' },
      { membershipId: w.other.membershipId, unitId: null, role: 'attendee', rsvp: 'no' },
    ].sort((a, b) => a.membershipId.localeCompare(b.membershipId));
    expect(snapshot).toEqual({ entity_type: 'item_board', version: 2, snapshot: { allocations } });
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(await refusal(items.rsvp(as(w.member), w.itemId, { rsvp: 'yes' }))).toBe(
      'trip_archived',
    );
    expect(await board(w.itemId)).toEqual([]);
  });
});
