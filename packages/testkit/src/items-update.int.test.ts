// @module-tag drop-a
// items.update (Drop A): Merge-patch item, visibility, sharedWith; masked_field_write; going private: item owner or organizer; If-Match = item version; board saves and RSVPs never conflict; trip_archived on archived trips (R29); sharedWith = membership ids of the trip; owner = callers membership (rule 3)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { createItemsService, writePath, type ItemsService } from '@tribo/core';
import { open, type Keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
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
  type UserFixture,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let keys: Keyring;
let items: ItemsService;
let n = 0;
const as = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `req-${String(n)}`, surface: 'web', userId: user.userId };
};
const mem = (id: string) => encodeTypeId(ID_PREFIX.membership, id);

beforeAll(async () => {
  tdb = await createTestDatabase();
  keys = testKeys();
  items = createItemsService(tdb.db, writePath(tdb.db), keys);
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
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
  const itemId = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.member.membershipId,
    type: 'activity',
    title: 'Island hopping',
  });
  return { ...w, itemId };
}

const stored = (itemId: string) =>
  tdb.db.selectFrom('tribo.items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();

const shares = async (itemId: string) =>
  (
    await tdb.db
      .selectFrom('tribo.item_shares')
      .select('membership_id')
      .where('item_id', '=', itemId)
      .orderBy('membership_id')
      .execute()
  ).map((s) => s.membership_id);

describe('items.update', () => {
  it('lets owner, organizer and the owning member merge-patch; absent keys stay', async () => {
    const w = await world();
    const a = await items.update(as(w.member), w.itemId, { title: 'Island hopping, 3 isles' }, 1);
    expect(a).toMatchObject({ title: 'Island hopping, 3 isles', type: 'activity', version: 2 });
    const b = await items.update(as(w.organizer), w.itemId, { status: 'booked' }, 2);
    expect(b).toMatchObject({ title: 'Island hopping, 3 isles', status: 'booked', version: 3 });
    const c = await items.update(as(w.owner), w.itemId, { tags: ['boat'] }, 3);
    expect(c).toMatchObject({ tags: ['boat'], version: 4 });
    // The owner never changes: the item stays the member's (rule 3).
    expect(c.ownerMembershipId).toBe(w.member.membershipId);
    expect((await stored(w.itemId)).updated_by).toBe(w.owner.userId);
  });

  it("refuses a viewer and a member editing another's item; an assignee may edit it", async () => {
    const w = await world();
    const body = { title: 'Sunset cruise' };
    expect(await refusal(items.update(as(w.viewer), w.itemId, body, 1))).toBe('forbidden');
    expect(await refusal(items.update(as(w.other), w.itemId, body, 1))).toBe('forbidden');
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.itemId,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    await expect(items.update(as(w.other), w.itemId, body, 1)).resolves.toMatchObject({
      title: 'Sunset cruise',
    });
  });

  it('answers not_found outside the trip and for an item the caller cannot see', async () => {
    const w = await world();
    const body = { title: 'Sunset cruise' };
    expect(await refusal(items.update(as(w.outsider), w.itemId, body, 1))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      visibility: 'private',
    });
    expect(await refusal(items.update(as(w.owner), secret, body, 1))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.itemId);
    expect(await refusal(items.update(as(w.member), w.itemId, body, 1))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await world();
    await items.update(
      as(w.member),
      w.itemId,
      { start: { local: '2026-11-12T08:00', tz: 'Asia/Manila' } },
      1,
    );
    const bodies = [
      { title: '' },
      { type: 'meal' },
      { ownerMembershipId: mem(w.owner.membershipId) },
      { cardLast4: '12a4' },
      { cost: { amountMinor: -1, currency: 'PHP' } },
      { sharedWith: [mem(w.other.membershipId)] },
      { visibility: 'selected', sharedWith: [mem(w.outsider.personId)] },
      { end: { date: '2026-11-12' } },
      { end: { local: '2026-11-12T07:00', tz: 'Asia/Manila' } },
      { start: null, end: { date: '2026-11-12' } },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(items.update(as(w.member), w.itemId, body, 2));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect((await stored(w.itemId)).version).toBe(2);
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await world();
    const edit = (ifMatch: number | undefined) =>
      items.update(as(w.member), w.itemId, { title: 'Snorkelling' }, ifMatch);
    expect(await refusal(edit(undefined))).toBe('if_match_required');
    expect(await refusal(edit(2))).toBe('version_conflict');
    expect(await refusal(edit(Number.NaN))).toBe('version_conflict');
    await expect(edit(1)).resolves.toMatchObject({ version: 2 });
    expect(await refusal(edit(1))).toBe('version_conflict');
  });

  it("bumps the item's version only, never its board_version (R26)", async () => {
    const w = await world();
    const updated = await items.update(as(w.member), w.itemId, { title: 'Snorkelling' }, 1);
    expect(updated).toMatchObject({ version: 2, boardVersion: 1 });
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await world();
    await items.update(
      as(w.member),
      w.itemId,
      {
        title: 'Snorkelling',
        bookingRef: 'PNR-7QX2',
        cost: { amountMinor: 250000, currency: 'PHP' },
      },
      1,
    );
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'version_before', 'version_after'])
      .where('entity_id', '=', w.itemId)
      .execute();
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'item',
        version_before: 1,
        version_after: 2,
      },
    ]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'trip_id', 'snapshot'])
      .where('entity_id', '=', w.itemId)
      .where('version', '=', 2)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({
      entity_type: 'item',
      trip_id: w.tripId,
      snapshot: {
        title: 'Snorkelling',
        cost: { amountMinor: 250000, currency: 'PHP' },
        bookingRefEnc: expect.any(String) as unknown,
        sharedWith: [],
      },
    });
    // The snapshot holds ciphertext, never the booking ref itself.
    expect(JSON.stringify(snapshot.snapshot)).not.toContain('PNR-7QX2');
  });

  it('stores booking ref and card last-4 encrypted, reads them masked, clears them with null', async () => {
    const w = await world();
    const set = await items.update(
      as(w.member),
      w.itemId,
      { bookingRef: 'PNR-7QX2', cardLast4: '4242' },
      1,
    );
    expect(set).toMatchObject({ bookingRef: 'masked', cardLast4: 'masked' });
    const row = await stored(w.itemId);
    if (!row.booking_ref_enc || !row.card_last4_enc) throw new Error('no ciphertext stored');
    const field = (column: string) => ({ table: 'items', column, rowId: w.itemId });
    expect(open(keys, field('booking_ref_enc'), row.booking_ref_enc).toString()).toBe('PNR-7QX2');
    expect(open(keys, field('card_last4_enc'), row.card_last4_enc).toString()).toBe('4242');

    await items.update(as(w.member), w.itemId, { title: 'Snorkelling' }, 2);
    expect((await stored(w.itemId)).booking_ref_enc).toEqual(row.booking_ref_enc);
    const cleared = await items.update(as(w.member), w.itemId, { bookingRef: null }, 3);
    expect(cleared).toMatchObject({ bookingRef: null, cardLast4: 'masked' });
  });

  it('answers masked_field_write to a masked booking ref, card last-4 or cost, writing nothing', async () => {
    const w = await world();
    for (const field of ['bookingRef', 'cardLast4', 'cost']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(
        items.update(as(w.member), w.itemId, { title: 'X', [field]: { masked: true } }, 1),
      );
      expect(code, field).toBe('masked_field_write');
    }
    expect((await stored(w.itemId)).version).toBe(1);
  });

  it('lets only the item owner or an organizer take an item private or selected', async () => {
    const w = await world();
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.itemId,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    // An assignee edits the item but may not hide it from the group.
    expect(await refusal(items.update(as(w.other), w.itemId, { visibility: 'private' }, 1))).toBe(
      'forbidden',
    );
    expect(
      await refusal(
        items.update(
          as(w.other),
          w.itemId,
          { visibility: 'selected', sharedWith: [mem(w.other.membershipId)] },
          1,
        ),
      ),
    ).toBe('forbidden');
    // The item's owner and an organizer may.
    await expect(
      items.update(as(w.member), w.itemId, { visibility: 'private' }, 1),
    ).resolves.toMatchObject({ visibility: 'private' });
    await expect(
      items.update(as(w.member), w.itemId, { visibility: 'shared' }, 2),
    ).resolves.toMatchObject({ visibility: 'shared' });
    await expect(
      items.update(as(w.organizer), w.itemId, { visibility: 'private' }, 3),
    ).resolves.toMatchObject({ visibility: 'private' });
  });

  it('replaces sharedWith with membership ids of the trip, and drops the shares on leaving selected', async () => {
    const w = await world();
    const picked = [w.other.membershipId, w.viewer.membershipId].sort();
    const selected = await items.update(
      as(w.member),
      w.itemId,
      { visibility: 'selected', sharedWith: picked.map(mem) },
      1,
    );
    expect(selected.visibility).toBe('selected');
    expect(await shares(w.itemId)).toEqual(picked);
    await items.update(as(w.member), w.itemId, { sharedWith: [mem(w.viewer.membershipId)] }, 2);
    expect(await shares(w.itemId)).toEqual([w.viewer.membershipId]);
    await items.update(as(w.member), w.itemId, { title: 'Still selected' }, 3);
    expect(await shares(w.itemId)).toEqual([w.viewer.membershipId]);
    await items.update(as(w.member), w.itemId, { visibility: 'shared' }, 4);
    expect(await shares(w.itemId)).toEqual([]);
  });

  it('merge-patches times: a new start keeps the end, null clears', async () => {
    const w = await world();
    await items.update(
      as(w.member),
      w.itemId,
      { start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
      1,
    );
    const moved = await items.update(as(w.member), w.itemId, { start: { date: '2026-11-11' } }, 2);
    expect(moved).toMatchObject({ start: { date: '2026-11-11' }, end: { date: '2026-11-13' } });
    const cleared = await items.update(as(w.member), w.itemId, { start: null, end: null }, 3);
    expect(cleared).toMatchObject({ start: null, end: null });
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(await refusal(items.update(as(w.member), w.itemId, { title: 'Too late' }, 1))).toBe(
      'trip_archived',
    );
    expect((await stored(w.itemId)).version).toBe(1);
  });
});
