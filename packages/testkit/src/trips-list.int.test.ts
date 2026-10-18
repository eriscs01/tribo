// trips.list: the caller's member trips only, latest start first, in keyset pages.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { createTripsService, writePath, type TripsService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTrip, createUser, softDelete } from './factories.js';

let tdb: TestDatabase;
let trips: TripsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  trips = createTripsService(tdb.db, writePath(tdb.db));
});
afterAll(() => tdb.destroy());

const ids = async (userId: string) =>
  (await trips.list(userId, { limit: PAGE_LIMIT_MAX })).items.map((t) => t.id);

describe('trips.list', () => {
  it('lists trips the caller is an active member of, and no others', async () => {
    const ana = await createUser(tdb.db);
    const ben = await createUser(tdb.db);
    const own = await createTrip(tdb.db, { owner: ana });
    const joined = await createTrip(tdb.db, { owner: ben });
    await addMember(tdb.db, { tripId: joined.tripId, personId: ana.personId, role: 'member' });
    const left = await createTrip(tdb.db, { owner: ben });
    const removed = await addMember(tdb.db, {
      tripId: left.tripId,
      personId: ana.personId,
      role: 'viewer',
    });
    await softDelete(tdb.db, 'tribo.memberships', removed);
    const deleted = await createTrip(tdb.db, { owner: ana });
    await softDelete(tdb.db, 'tribo.trips', deleted.tripId);
    await createTrip(tdb.db, { owner: ben });

    expect((await ids(ana.userId)).sort()).toEqual([own.tripId, joined.tripId].sort());
  });

  it('gives a platform admin no implicit access', async () => {
    const owner = await createUser(tdb.db);
    await createTrip(tdb.db, { owner });
    const admin = await createUser(tdb.db, { platformRole: 'admin' });
    expect(await ids(admin.userId)).toEqual([]);
  });

  it('lists an archived trip with status archived', async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', tripId)
      .execute();
    const page = await trips.list(owner.userId, { limit: 50 });
    expect(page.items).toEqual([expect.objectContaining({ id: tripId, status: 'archived' })]);
  });

  it('pages latest start first, ties by id, until nextCursor is null', async () => {
    const owner = await createUser(tdb.db);
    const starts = ['2026-11-01', '2026-12-24', '2026-11-11', '2026-11-11', '2027-01-05'];
    const created = await Promise.all(
      starts.map(async (start) => ({
        start,
        ...(await createTrip(tdb.db, { owner, start, end: '2027-02-01' })),
      })),
    );
    const expected = created
      .sort((a, b) => b.start.localeCompare(a.start) || b.tripId.localeCompare(a.tripId))
      .map((t) => t.tripId);

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
      const page = await trips.list(owner.userId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((t) => t.id));
      sizes.push(page.items.length);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(expected);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('ends on a full last page with nextCursor null', async () => {
    const owner = await createUser(tdb.db);
    await createTrip(tdb.db, { owner });
    await createTrip(tdb.db, { owner });
    const page = await trips.list(owner.userId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a key of the wrong shape', Buffer.from('["x","y"]').toString('base64url')],
  ])('refuses %s as validation_failed on /cursor', async (_name, cursor) => {
    const owner = await createUser(tdb.db);
    const refusal = await trips.list(owner.userId, { limit: 2, cursor }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: '/cursor' }] },
    });
  });
});
