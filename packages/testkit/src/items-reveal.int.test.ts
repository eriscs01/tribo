// @module-tag drop-a
// items.reveal (Drop A): Plaintext of bookingRef, cardLast4; Audited reveal (field paths only); never cached offline; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Allowed on archived trips (a read, audited); refused with trip_retired after retirement
import { createItemsService, writePath, type ItemsService } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
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
  return { requestId: `items-reveal-${String(n)}`, surface: 'web', userId: user.userId };
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

/**
 * A trip with one member of each role, a second member and an outsider. The member made a
 * flight through items.create and stored its booking ref and card through items.update.
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
    owner,
    organizer: await member('organizer'),
    member: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
  const flight = await items.create(as(w.member), tripId, {
    type: 'transport',
    title: 'MNL to TAG',
  });
  await items.update(
    as(w.member),
    flight.id,
    { bookingRef: 'PNR-7QX2', cardLast4: '4242' },
    flight.version,
  );
  return { ...w, itemId: flight.id };
}

const both = { fields: ['bookingRef', 'cardLast4'] };

const reveals = (itemId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('entity_id', '=', itemId)
    .where('action', '=', 'reveal')
    .orderBy('seq')
    .execute();

const retire = (tripId: string) =>
  tdb.db
    .updateTable('tribo.trips')
    .set({ status: 'completed', archived_at: new Date(), audit_retired_at: new Date() })
    .where('id', '=', tripId)
    .execute();

describe('items.reveal', () => {
  it('returns the plaintext of the fields asked for, and only those', async () => {
    const w = await world();
    expect(await items.reveal(as(w.member), w.itemId, both)).toEqual({
      bookingRef: 'PNR-7QX2',
      cardLast4: '4242',
    });
    expect(await items.reveal(as(w.member), w.itemId, { fields: ['cardLast4'] })).toEqual({
      cardLast4: '4242',
    });
  });

  it('answers null for a field with no stored value', async () => {
    const w = await world();
    const bare = await items.create(as(w.member), w.tripId, { type: 'meal', title: 'Lunch' });
    expect(await items.reveal(as(w.member), bare.id, both)).toEqual({
      bookingRef: null,
      cardLast4: null,
    });
  });

  it('lets owner, organizer and the owning member reveal; refuses a viewer and another member', async () => {
    const w = await world();
    for (const user of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      await expect(items.reveal(as(user), w.itemId, both)).resolves.toMatchObject({
        bookingRef: 'PNR-7QX2',
      });
    }
    expect(await refusal(items.reveal(as(w.viewer), w.itemId, both))).toBe('forbidden');
    expect(await refusal(items.reveal(as(w.other), w.itemId, both))).toBe('forbidden');
    // Being assigned to it is not owning it.
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.itemId,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    expect(await refusal(items.reveal(as(w.other), w.itemId, both))).toBe('forbidden');
  });

  it('answers not_found outside the trip and for an item the caller cannot see', async () => {
    const w = await world();
    expect(await refusal(items.reveal(as(w.outsider), w.itemId, both))).toBe('not_found');
    const secret = await items.create(as(w.other), w.tripId, {
      type: 'note',
      title: 'Surprise',
      visibility: 'private',
    });
    expect(await refusal(items.reveal(as(w.owner), secret.id, both))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, revealing and recording nothing', async () => {
    const w = await world();
    for (const body of [
      {},
      { fields: [] },
      { fields: ['title'] },
      { fields: ['bookingRef', 'bookingRef'] },
      null,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(items.reveal(as(w.member), w.itemId, body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await reveals(w.itemId)).toEqual([]);
  });

  it('records a reveal event naming the field paths, never the values, and no snapshot', async () => {
    const w = await world();
    const versions = async () =>
      (
        await tdb.db
          .selectFrom('tribo.entity_versions')
          .select('version')
          .where('entity_id', '=', w.itemId)
          .execute()
      ).length;
    const before = await versions();
    await items.reveal(as(w.organizer), w.itemId, both);
    const [event, ...rest] = await reveals(w.itemId);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      chain_key: `trip:${w.tripId}`,
      action: 'reveal',
      entity_type: 'item',
      trip_id: w.tripId,
      actor_user_id: w.organizer.userId,
      reason: '/bookingRef,/cardLast4',
      version_before: null,
      version_after: null,
    });
    expect(JSON.stringify(event)).not.toContain('PNR-7QX2');
    expect(JSON.stringify(event)).not.toContain('4242');
    expect(await versions()).toBe(before);
  });

  it('is never replayed: each call is its own audited reveal (R2)', async () => {
    const w = await world();
    await items.reveal(as(w.member), w.itemId, { fields: ['bookingRef'] });
    await items.reveal(as(w.member), w.itemId, { fields: ['bookingRef'] });
    expect(await reveals(w.itemId)).toHaveLength(2);
  });

  it('works on an archived trip (a read, audited)', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    await expect(items.reveal(as(w.member), w.itemId, both)).resolves.toMatchObject({
      bookingRef: 'PNR-7QX2',
    });
    expect(await reveals(w.itemId)).toHaveLength(1);
  });

  it('answers trip_retired once the audit chain is retired, revealing nothing', async () => {
    const w = await world();
    await retire(w.tripId);
    expect(await refusal(items.reveal(as(w.member), w.itemId, both))).toBe('trip_retired');
  });
});
