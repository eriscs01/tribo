// @module-tag drop-a
// items.delete (Drop A): Soft-delete item and children; Undo via items.restore (1b); MCP approval; trip_archived on archived trips (R29)
import { NoBody, PAGE_LIMIT_MAX } from '@tribo/contract';
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
  return { requestId: `items-delete-${String(n)}`, surface: 'web', userId: user.userId };
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

/** A trip with one member of each role, a second member and an outsider; the member owns an item. */
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
    owner,
    organizer: await member('organizer'),
    member: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
  const itemId = await createItem(tdb.db, { tripId, ownerMembershipId: w.member.membershipId });
  return { ...w, itemId };
}

const stored = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.items')
    .select(['version', 'deleted_at', 'deleted_by'])
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();

const remove = (user: UserFixture, itemId: string, ifMatch: number | undefined) =>
  items.delete(as(user), itemId, undefined, ifMatch);

describe('items.delete', () => {
  it('lets the owning member soft-delete their item; reads no longer find it', async () => {
    const w = await world();
    await remove(w.member, w.itemId, 1);
    const row = await stored(w.itemId);
    expect(row).toMatchObject({ version: 2, deleted_by: w.member.userId });
    expect(row.deleted_at).not.toBeNull();
    expect(await refusal(items.get(w.owner.userId, w.itemId))).toBe('not_found');
    const page = await items.list(w.owner.userId, w.tripId, { limit: PAGE_LIMIT_MAX });
    expect(page.items).toEqual([]);
  });

  it('lets the trip owner and an organizer delete any item they see', async () => {
    const w = await world();
    const second = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
    });
    await remove(w.owner, w.itemId, 1);
    await remove(w.organizer, second, 1);
    expect((await stored(w.itemId)).deleted_by).toBe(w.owner.userId);
    expect((await stored(second)).deleted_by).toBe(w.organizer.userId);
  });

  it("refuses a viewer and a member deleting another's item, even as its assignee", async () => {
    const w = await world();
    expect(await refusal(remove(w.viewer, w.itemId, 1))).toBe('forbidden');
    expect(await refusal(remove(w.other, w.itemId, 1))).toBe('forbidden');
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.itemId,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    expect(await refusal(remove(w.other, w.itemId, 1))).toBe('forbidden');
    expect((await stored(w.itemId)).deleted_at).toBeNull();
  });

  it('answers not_found outside the trip, for a hidden item and for one already deleted', async () => {
    const w = await world();
    expect(await refusal(remove(w.outsider, w.itemId, 1))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      visibility: 'private',
    });
    expect(await refusal(remove(w.owner, secret, 1))).toBe('not_found');
    await remove(w.member, w.itemId, 1);
    expect(await refusal(remove(w.member, w.itemId, 2))).toBe('not_found');
  });

  it('refuses a request body with validation_failed', async () => {
    const w = await world();
    expect(NoBody.safeParse({}).success).toBe(false);
    expect(await refusal(items.delete(as(w.member), w.itemId, {}, 1))).toBe('validation_failed');
    expect((await stored(w.itemId)).deleted_at).toBeNull();
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await world();
    expect(await refusal(remove(w.member, w.itemId, undefined))).toBe('if_match_required');
    expect(await refusal(remove(w.member, w.itemId, 2))).toBe('version_conflict');
    expect((await stored(w.itemId)).deleted_at).toBeNull();
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await world();
    await remove(w.member, w.itemId, 1);
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select([
        'chain_key',
        'action',
        'entity_type',
        'version_before',
        'version_after',
        'request_id',
      ])
      .where('entity_id', '=', w.itemId)
      .execute();
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'delete',
        entity_type: 'item',
        version_before: 1,
        version_after: 2,
        request_id: expect.stringMatching(/^items-delete-/) as unknown,
      },
    ]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'snapshot'])
      .where('entity_id', '=', w.itemId)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({
      entity_type: 'item',
      version: 2,
      snapshot: { visibility: 'shared', ownerMembershipId: w.member.membershipId },
    });
  });

  it('answers trip_archived on an archived trip, deleting nothing', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(await refusal(remove(w.member, w.itemId, 1))).toBe('trip_archived');
    expect((await stored(w.itemId)).deleted_at).toBeNull();
  });
});
