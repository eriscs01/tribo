// @module-tag drop-a
// Item restrictedFields (items.get story; set through items.create and items.update): a
// restricted field is masked for every caller except the item's owner membership and the
// trip's owner and organizers, who alone may change the set; a write to a restricted field
// by anyone else answers masked_field_write. Proven through the items service against
// PostgreSQL; apps/server/src/items.int.test.ts proves the REST shape.
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
  return { requestId: `req-rf-${String(n)}`, surface: 'web', userId: user.userId };
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

const COST = { amountMinor: 18_000, currency: 'EUR' };

/**
 * A trip with one member of each role; `member` owns a priced item whose cost is
 * restricted, and `assignee` is assigned to it.
 */
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
    assignee: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
  };
  const itemId = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.member.membershipId,
    title: 'Catamaran charter',
    cost: COST,
  });
  await items.update(as(w.member), itemId, { restrictedFields: ['cost'] }, 1);
  await addAllocation(tdb.db, {
    tripId,
    itemId,
    membershipId: w.assignee.membershipId,
    role: 'assignee',
  });
  return { ...w, itemId };
}

const stored = (itemId: string) =>
  tdb.db.selectFrom('tribo.items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();

describe('item restrictedFields', () => {
  it('masks a restricted cost for everyone but the item owner and the trip owner and organizers', async () => {
    const w = await world();
    const read = (reader: UserFixture) => items.get(reader.userId, w.itemId);
    expect((await read(w.member)).cost).toEqual(COST);
    expect((await read(w.owner)).cost).toEqual(COST);
    expect((await read(w.organizer)).cost).toEqual(COST);
    // Being assigned is not enough, and neither is canViewCosts.
    expect(await read(w.assignee)).toMatchObject({ cost: 'masked', restrictedFields: ['cost'] });
    expect((await read(w.other)).cost).toBe('masked');
    expect((await read(w.viewer)).cost).toBe('masked');
  });

  it('masks it in items.list too, through the same serializer', async () => {
    const w = await world();
    const listed = async (user: UserFixture) =>
      (await items.list(user.userId, w.tripId, { limit: 50 })).items.find((i) => i.id === w.itemId);
    expect((await listed(w.other))?.cost).toBe('masked');
    expect((await listed(w.organizer))?.cost).toEqual(COST);
  });

  it('renders a restricted field that holds nothing as masked, so its absence does not show', async () => {
    const w = await world();
    const bare = await items.create(as(w.member), w.tripId, {
      type: 'note',
      title: 'Harbour fees',
      restrictedFields: ['cost', 'bookingRef'],
    });
    expect(bare).toMatchObject({
      cost: null,
      bookingRef: null,
      restrictedFields: ['cost', 'bookingRef'],
    });
    const seen = await items.get(w.other.userId, bare.id);
    expect(seen).toMatchObject({ cost: 'masked', bookingRef: 'masked', cardLast4: null });
  });

  it('is set on create and on update by the item owner, the trip owner or an organizer', async () => {
    const w = await world();
    const created = await items.create(as(w.member), w.tripId, {
      type: 'activity',
      title: 'Snorkelling',
      restrictedFields: ['cardLast4', 'cost'],
    });
    // Kept in the closed set's order, whatever order the caller sent.
    expect(created.restrictedFields).toEqual(['cost', 'cardLast4']);
    expect((await stored(created.id)).restricted_fields).toEqual(['cost', 'cardLast4']);
    const a = await items.update(as(w.organizer), created.id, { restrictedFields: ['cost'] }, 1);
    expect(a.restrictedFields).toEqual(['cost']);
    const b = await items.update(as(w.owner), created.id, { restrictedFields: [] }, 2);
    expect(b.restrictedFields).toEqual([]);
  });

  it('refuses anyone else changing the set with forbidden, writing nothing', async () => {
    const w = await world();
    expect(await refusal(items.update(as(w.assignee), w.itemId, { restrictedFields: [] }, 2))).toBe(
      'forbidden',
    );
    expect((await stored(w.itemId)).restricted_fields).toEqual(['cost']);
    expect((await stored(w.itemId)).version).toBe(2);
  });

  it('answers masked_field_write to a write of a restricted field by a caller it is masked for', async () => {
    const w = await world();
    const write = { cost: { amountMinor: 1, currency: 'EUR' } };
    expect(await refusal(items.update(as(w.assignee), w.itemId, write, 2))).toBe(
      'masked_field_write',
    );
    expect(Number((await stored(w.itemId)).cost_minor)).toBe(COST.amountMinor);
    // Unrestricted fields stay writable for the assignee, and the owner writes the cost.
    await expect(
      items.update(as(w.assignee), w.itemId, { title: 'Catamaran day' }, 2),
    ).resolves.toMatchObject({ title: 'Catamaran day', cost: 'masked' });
    await expect(items.update(as(w.member), w.itemId, write, 3)).resolves.toMatchObject({
      cost: write.cost,
    });
  });

  it('refuses a field outside the maskable set, and each field twice, with validation_failed', async () => {
    const w = await world();
    const bad = (restrictedFields: unknown) =>
      refusal(items.update(as(w.member), w.itemId, { restrictedFields }, 2));
    expect(await bad(['title'])).toBe('validation_failed');
    expect(await bad(['cost', 'cost'])).toBe('validation_failed');
    // The database's CHECK holds the same closed set.
    await expect(
      tdb.db
        .updateTable('tribo.items')
        .set({ restricted_fields: ['title'] })
        .where('id', '=', w.itemId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'items_restricted_fields' });
  });

  it('records the set in the item snapshot', async () => {
    const w = await world();
    const { snapshot } = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select('snapshot')
      .where('entity_id', '=', w.itemId)
      .where('version', '=', 2)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({ restrictedFields: ['cost'] });
  });
});
