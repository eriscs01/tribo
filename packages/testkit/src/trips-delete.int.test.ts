// @module-tag drop-a
// trips.delete (Drop A): Soft-delete trip and children; Undo via trips.restore (1b); MCP approval; Allowed on archived trips; refused with trip_retired once the audit chain is retired (R29)
// Children drop out with the trip: tribo.is_member and tribo.item_visible ignore a deleted
// trip (R18), so the trip's deleted_at is the one fact that removes them. MCP approval is 1b.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import {
  createItemsService,
  createTripsService,
  moneyRecorded,
  writePath,
  type ItemsService,
  type TripsService,
} from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createItem,
  createTrip,
  createUser,
  type TripRole,
  type UserFixture,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let trips: TripsService;
let items: ItemsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  trips = createTripsService(tdb.db, writePath(tdb.db), moneyRecorded);
  items = createItemsService(tdb.db, writePath(tdb.db), testKeys());
});
afterAll(() => tdb.destroy());

let n = 0;
const ctx = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `trips-delete-${String(n)}`, surface: 'web', userId: user.userId };
};
const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

async function world() {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  return { owner, ...trip };
}

const stored = (tripId: string) =>
  tdb.db
    .selectFrom('tribo.trips')
    .select(['deleted_at', 'deleted_by', 'version'])
    .where('id', '=', tripId)
    .executeTakeFirstOrThrow();

const archive = (tripId: string, retired = false) =>
  tdb.db
    .updateTable('tribo.trips')
    .set({
      status: 'completed',
      archived_at: new Date(),
      ...(retired ? { audit_retired_at: new Date() } : {}),
    })
    .where('id', '=', tripId)
    .execute();

describe('trips.delete', () => {
  it('lets the owner soft-delete the trip, bumping its version', async () => {
    const { owner, tripId } = await world();
    await trips.delete(ctx(owner), tripId, undefined, 1);
    expect(await stored(tripId)).toMatchObject({
      deleted_at: expect.any(Date) as unknown,
      deleted_by: owner.userId,
      version: 2,
    });
  });

  it.each<TripRole>(['organizer', 'member', 'viewer'])(
    'refuses an %s with forbidden',
    async (role) => {
      const { tripId } = await world();
      const other = await createUser(tdb.db);
      await addMember(tdb.db, { tripId, personId: other.personId, role });
      expect(await refusal(trips.delete(ctx(other), tripId, undefined, 1))).toMatchObject({
        code: 'forbidden',
      });
      expect(await stored(tripId)).toMatchObject({ deleted_at: null, version: 1 });
    },
  );

  it('answers not_found to an account outside the trip, a platform admin included', async () => {
    const { tripId } = await world();
    for (const outsider of [
      await createUser(tdb.db),
      await createUser(tdb.db, { platformRole: 'admin' }),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- two callers, one assertion each
      expect(await refusal(trips.delete(ctx(outsider), tripId, undefined, 1))).toMatchObject({
        code: 'not_found',
      });
    }
  });

  it('answers not_found once the trip is deleted, so a repeat changes nothing', async () => {
    const { owner, tripId } = await world();
    await trips.delete(ctx(owner), tripId, undefined, 1);
    expect(await refusal(trips.delete(ctx(owner), tripId, undefined, 2))).toMatchObject({
      code: 'not_found',
    });
    expect(await stored(tripId)).toMatchObject({ version: 2 });
  });

  it('refuses a body with validation_failed: a DELETE takes none', async () => {
    const { owner, tripId } = await world();
    expect(await refusal(trips.delete(ctx(owner), tripId, {}, 1))).toMatchObject({
      code: 'validation_failed',
    });
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const { owner, tripId } = await world();
    expect(await refusal(trips.delete(ctx(owner), tripId, undefined, undefined))).toMatchObject({
      code: 'if_match_required',
    });
    expect(await refusal(trips.delete(ctx(owner), tripId, undefined, 3))).toMatchObject({
      code: 'version_conflict',
    });
    expect(await stored(tripId)).toMatchObject({ deleted_at: null, version: 1 });
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const { owner, tripId } = await world();
    const c = ctx(owner);
    await trips.delete(c, tripId, undefined, 1);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .selectAll()
      .where('entity_type', '=', 'trip')
      .where('entity_id', '=', tripId)
      .execute();
    expect(snapshots).toEqual([
      expect.objectContaining({
        version: 2,
        trip_id: tripId,
        snapshot: expect.objectContaining({ status: 'planning', destinations: [] }) as unknown,
      }),
    ]);
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .selectAll()
      .where('entity_id', '=', tripId)
      .execute();
    expect(events).toEqual([
      expect.objectContaining({
        action: 'delete',
        entity_type: 'trip',
        trip_id: tripId,
        version_before: 1,
        version_after: 2,
        request_id: c.requestId,
      }),
    ]);
  });

  it('hides every child from every former member: a cascade derived from the trip (R18)', async () => {
    const { owner, tripId, ownerMembershipId } = await world();
    const members = [owner];
    const membershipIds = [ownerMembershipId];
    for (const role of ['organizer', 'member', 'viewer'] as const) {
      /* eslint-disable no-await-in-loop -- one member per role, in order */
      const user = await createUser(tdb.db);
      membershipIds.push(await addMember(tdb.db, { tripId, personId: user.personId, role }));
      /* eslint-enable no-await-in-loop */
      members.push(user);
    }
    // One item of each visibility, each visible to every member before the delete.
    const itemIds = [
      await createItem(tdb.db, { tripId, ownerMembershipId, visibility: 'shared' }),
      await createItem(tdb.db, {
        tripId,
        ownerMembershipId,
        visibility: 'selected',
        sharedWith: membershipIds.slice(1),
      }),
    ];
    const visible = (userId: string, itemId: string) =>
      sql<{ v: boolean }>`SELECT tribo.item_visible(${userId}, ${itemId}) AS v`
        .execute(tdb.db)
        .then((r) => r.rows[0]?.v);
    for (const user of members) {
      for (const itemId of itemIds) {
        // eslint-disable-next-line no-await-in-loop -- a small grid, checked cell by cell
        expect(await visible(user.userId, itemId)).toBe(true);
      }
    }

    await trips.delete(ctx(owner), tripId, undefined, 1);

    for (const user of members) {
      /* eslint-disable no-await-in-loop -- a small grid, checked cell by cell */
      expect(await refusal(trips.get(user.userId, tripId))).toMatchObject({ code: 'not_found' });
      const listed = await trips.list(user.userId, { limit: PAGE_LIMIT_MAX });
      expect(listed.items.map((t) => t.id)).not.toContain(tripId);
      for (const itemId of itemIds) {
        expect(await refusal(items.get(user.userId, itemId))).toMatchObject({
          code: 'not_found',
        });
        expect(await visible(user.userId, itemId)).toBe(false);
      }
      /* eslint-enable no-await-in-loop */
    }
    // Nothing under the trip was touched: the trip's deleted_at is the one stored fact.
    const stamped = await tdb.db
      .selectFrom('tribo.items')
      .select('id')
      .where('trip_id', '=', tripId)
      .where('deleted_at', 'is not', null)
      .execute();
    expect(stamped).toEqual([]);
  });

  it('is allowed on an archived trip', async () => {
    const { owner, tripId } = await world();
    await archive(tripId);
    await trips.delete(ctx(owner), tripId, undefined, 1);
    expect(await stored(tripId)).toMatchObject({ version: 2 });
  });

  it('answers trip_retired once the audit chain is retired, writing nothing', async () => {
    const { owner, tripId } = await world();
    await archive(tripId, true);
    expect(await refusal(trips.delete(ctx(owner), tripId, undefined, 1))).toMatchObject({
      code: 'trip_retired',
    });
    expect(await stored(tripId)).toMatchObject({ deleted_at: null, version: 1 });
  });
});
