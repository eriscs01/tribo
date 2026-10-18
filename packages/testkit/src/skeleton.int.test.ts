// Skeleton operations (s0 task 10): trips.create with its owner membership, items.create
// and items.get through tribo.item_visible, and audit chain verification.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import {
  createItemsService,
  createTripsService,
  verifyChains,
  writePath,
  type ItemsService,
  type TripsService,
} from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createItem, createTrip, createUser, softDelete } from './factories.js';

let tdb: TestDatabase;
let trips: TripsService;
let items: ItemsService;
let n = 0;

const as = (userId: string): RequestContext => ({
  requestId: `req-${String(++n)}`,
  surface: 'web',
  userId,
});
const mfa = { mfaVerified: true };
const trip = {
  name: 'Island weekend',
  startDate: '2026-11-11',
  endDate: '2026-11-14',
  currency: 'PHP',
  timezone: 'Asia/Manila',
};
const mem = (id: string) => encodeTypeId(ID_PREFIX.membership, id);

beforeAll(async () => {
  tdb = await createTestDatabase();
  const write = writePath(tdb.db);
  trips = createTripsService(tdb.db, write);
  items = createItemsService(tdb.db, write);
});
afterAll(() => tdb.destroy());

const events = (tripId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select(['chain_key', 'seq', 'action', 'entity_type', 'entity_id', 'version_after'])
    .where('trip_id', '=', tripId)
    .orderBy('seq')
    .execute();

const snapshots = (entityId: string) =>
  tdb.db
    .selectFrom('tribo.entity_versions')
    .select(['entity_type', 'version', 'snapshot'])
    .where('entity_id', '=', entityId)
    .execute();

async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

/** A trip made through trips.create, plus a member and a viewer added by the factories. */
async function world() {
  const owner = await createUser(tdb.db);
  const created = await trips.create(as(owner.userId), mfa, trip);
  const { id: ownerMembership } = await tdb.db
    .selectFrom('tribo.memberships')
    .select('id')
    .where('trip_id', '=', created.id)
    .executeTakeFirstOrThrow();
  const member = await createUser(tdb.db);
  const viewer = await createUser(tdb.db);
  const memberMembership = await addMember(tdb.db, {
    tripId: created.id,
    personId: member.personId,
    role: 'member',
  });
  await addMember(tdb.db, { tripId: created.id, personId: viewer.personId, role: 'viewer' });
  return { owner, member, viewer, tripId: created.id, ownerMembership, memberMembership };
}

describe('trips.create', () => {
  it('writes the trip and the owner membership, each with its snapshot and event', async () => {
    const owner = await createUser(tdb.db);
    const created = await trips.create(as(owner.userId), mfa, { ...trip, name: '  Trimmed  ' });
    expect(created).toMatchObject({
      name: 'Trimmed',
      startDate: '2026-11-11',
      endDate: '2026-11-14',
      currency: 'PHP',
      timezone: 'Asia/Manila',
      status: 'draft',
      version: 1,
    });

    const membership = await tdb.db
      .selectFrom('tribo.memberships')
      .select(['id', 'person_id', 'trip_role', 'version'])
      .where('trip_id', '=', created.id)
      .execute();
    expect(membership).toEqual([
      expect.objectContaining({ person_id: owner.personId, trip_role: 'owner', version: 1 }),
    ]);

    expect(await events(created.id)).toEqual([
      expect.objectContaining({
        chain_key: `trip:${created.id}`,
        seq: '1',
        action: 'create',
        entity_type: 'trip',
        entity_id: created.id,
        version_after: 1,
      }),
      expect.objectContaining({
        seq: '2',
        action: 'create',
        entity_type: 'membership',
        entity_id: membership[0]?.id,
      }),
    ]);
    expect(await snapshots(created.id)).toEqual([
      {
        entity_type: 'trip',
        version: 1,
        snapshot: expect.objectContaining({ name: 'Trimmed', status: 'draft' }) as unknown,
      },
    ]);
  });

  it('refuses an owner whose session passed no second factor, writing nothing', async () => {
    const owner = await createUser(tdb.db);
    const error = await refusal(trips.create(as(owner.userId), { mfaVerified: false }, trip));
    expect(error.code).toBe('mfa_required');
    const rows = await tdb.db
      .selectFrom('tribo.trips')
      .select('id')
      .where('created_by', '=', owner.userId)
      .execute();
    expect(rows).toEqual([]);
  });

  it('validates the body: dates in order, a real zone in the domain shape', async () => {
    const owner = await createUser(tdb.db);
    const bad = [
      { ...trip, endDate: '2026-11-10' },
      { ...trip, timezone: 'EST' },
      { ...trip, currency: 'php' },
      { ...trip, extra: true },
    ];
    for (const body of bad) {
      expect((await refusal(trips.create(as(owner.userId), mfa, body))).code).toBe(
        'validation_failed',
      );
    }
  });
});

describe('items.create', () => {
  it('resolves wall-clock time in its zone and records the create in the trip chain', async () => {
    const w = await world();
    const item = await items.create(as(w.member.userId), w.tripId, {
      type: 'transport',
      title: 'Morning ferry',
      start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
      end: { local: '2026-11-11T09:30', tz: 'Asia/Manila' },
      tags: ['ferry'],
    });
    expect(item).toMatchObject({
      tripId: w.tripId,
      type: 'transport',
      status: 'planned',
      visibility: 'shared',
      ownerMembershipId: w.memberMembership,
      start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
      end: { local: '2026-11-11T09:30', tz: 'Asia/Manila' },
      tags: ['ferry'],
      version: 1,
      boardVersion: 1,
    });
    expect(item.start && 'at' in item.start && item.start.at.toISOString()).toBe(
      '2026-11-10T23:40:00.000Z',
    );

    const chain = await events(w.tripId);
    expect(chain.at(-1)).toMatchObject({
      chain_key: `trip:${w.tripId}`,
      action: 'create',
      entity_type: 'item',
      entity_id: item.id,
      version_after: 1,
    });
    expect(await snapshots(item.id)).toEqual([
      {
        entity_type: 'item',
        version: 1,
        snapshot: expect.objectContaining({
          title: 'Morning ferry',
          start: { at: '2026-11-10T23:40:00.000Z', tz: 'Asia/Manila' },
          ownerMembershipId: w.memberMembership,
          sharedWith: [],
        }) as unknown,
      },
    ]);
  });

  it('takes all-day dates and selected visibility with members of the trip', async () => {
    const w = await world();
    const item = await items.create(as(w.owner.userId), w.tripId, {
      type: 'activity',
      title: 'Waterfall hike',
      start: { date: '2026-11-12' },
      visibility: 'selected',
      sharedWith: [mem(w.memberMembership), mem(w.memberMembership)],
    });
    expect(item).toMatchObject({ start: { date: '2026-11-12' }, end: null });
    const shares = await tdb.db
      .selectFrom('tribo.item_shares')
      .select('membership_id')
      .where('item_id', '=', item.id)
      .execute();
    expect(shares).toEqual([{ membership_id: w.memberMembership }]);
  });

  it('refuses a viewer (forbidden) and someone outside the trip (not_found)', async () => {
    const w = await world();
    const outsider = await createUser(tdb.db);
    const body = { type: 'note', title: 'Packing' };
    expect((await refusal(items.create(as(w.viewer.userId), w.tripId, body))).code).toBe(
      'forbidden',
    );
    expect((await refusal(items.create(as(outsider.userId), w.tripId, body))).code).toBe(
      'not_found',
    );
  });

  it('refuses writes under an archived trip (R29) and a deleted one', async () => {
    const w = await world();
    const body = { type: 'note', title: 'Too late' };
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect((await refusal(items.create(as(w.owner.userId), w.tripId, body))).code).toBe(
      'trip_archived',
    );
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect((await refusal(items.create(as(w.owner.userId), w.tripId, body))).code).toBe(
      'not_found',
    );
  });

  it('refuses sharedWith outside the trip and times out of order, writing nothing', async () => {
    const w = await world();
    const other = await world();
    const before = (await events(w.tripId)).length;
    const bad = [
      {
        type: 'activity',
        title: 'Hike',
        visibility: 'selected',
        sharedWith: [mem(other.memberMembership)],
      },
      { type: 'note', title: 'Note', sharedWith: [mem(w.memberMembership)] },
      // 08:00 in Manila is 00:00 UTC, before 07:00 in Tokyo is 22:00 UTC the day before.
      {
        type: 'transport',
        title: 'Flight',
        start: { local: '2026-11-11T08:00', tz: 'Asia/Manila' },
        end: { local: '2026-11-11T07:00', tz: 'Asia/Tokyo' },
      },
      { type: 'meal', title: 'Dinner', start: { date: '2026-11-12' }, end: { date: '2026-11-11' } },
      {
        type: 'meal',
        title: 'Lunch',
        start: { date: '2026-11-12' },
        end: { local: '2026-11-12T13:00', tz: 'Asia/Manila' },
      },
      { type: 'meal', title: 'Breakfast', end: { date: '2026-11-12' } },
    ];
    for (const body of bad) {
      const error = await refusal(items.create(as(w.owner.userId), w.tripId, body));
      expect(error.code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await events(w.tripId)).toHaveLength(before);
  });
});

describe('items.get', () => {
  it('reads an item back only where tribo.item_visible holds', async () => {
    const w = await world();
    const outsider = await createUser(tdb.db);
    const shared = await items.create(as(w.owner.userId), w.tripId, {
      type: 'lodging',
      title: 'Guest house',
    });
    const secret = await items.create(as(w.owner.userId), w.tripId, {
      type: 'note',
      title: 'Organizer notes',
      visibility: 'private',
    });

    expect(await items.get(w.viewer.userId, shared.id)).toEqual(shared);
    expect(await items.get(w.owner.userId, secret.id)).toEqual(secret);
    for (const userId of [w.member.userId, w.viewer.userId, outsider.userId]) {
      expect((await refusal(items.get(userId, secret.id))).code).toBe('not_found');
    }
    expect((await refusal(items.get(outsider.userId, shared.id))).code).toBe('not_found');
  });

  it('hides items of a deleted trip and deleted items, from everyone', async () => {
    const owner = await createUser(tdb.db);
    const t = await createTrip(tdb.db, { owner });
    const gone = await createItem(tdb.db, {
      tripId: t.tripId,
      ownerMembershipId: t.ownerMembershipId,
    });
    const kept = await createItem(tdb.db, {
      tripId: t.tripId,
      ownerMembershipId: t.ownerMembershipId,
    });
    await softDelete(tdb.db, 'tribo.items', gone);
    expect((await refusal(items.get(owner.userId, gone))).code).toBe('not_found');
    expect((await items.get(owner.userId, kept)).id).toBe(kept);
    await softDelete(tdb.db, 'tribo.trips', t.tripId);
    expect((await refusal(items.get(owner.userId, kept))).code).toBe('not_found');
  });
});

describe('audit chain verification', () => {
  it('reports every chain intact, then names the first seq after a tampered event', async () => {
    const w = await world();
    await items.create(as(w.owner.userId), w.tripId, { type: 'note', title: 'One' });
    await items.create(as(w.owner.userId), w.tripId, { type: 'note', title: 'Two' });
    const chainKey = `trip:${w.tripId}`;

    const all = await verifyChains(tdb.db);
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter((r) => r.brokenAt !== null)).toEqual([]);
    expect(await verifyChains(tdb.db, chainKey)).toEqual([
      { chainKey, events: 4, headSeq: 4, brokenAt: null },
    ]);

    // Only a superuser with triggers off can change the log; verification still sees it.
    const su = connectAs(tdb.name, 'postgres');
    await su.connect();
    try {
      await su.query(`SET session_replication_role = replica`);
      await su.query(
        `UPDATE audit.audit_events SET entity_type = 'person' WHERE chain_key = $1 AND seq = 3`,
        [chainKey],
      );
    } finally {
      await su.end();
    }
    expect(await verifyChains(tdb.db, chainKey)).toEqual([
      { chainKey, events: 4, headSeq: 4, brokenAt: 3 },
    ]);
  });
});
