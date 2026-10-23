// @module-tag drop-b
// tickets.delete (Drop B): Remove ticket; trip_archived on archived trips (R29)
// Through the tickets service and the real trips, items and audit modules: a soft delete under
// If-Match by whoever manages the item's tickets, keeping the sealed number only as the
// snapshot a restore would copy, after which the passenger may get a new ticket.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createTicket, softDelete } from './factories.js';
import { ticketRows, ticketsWorld, type TicketsWorld } from './tickets-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const as = contexts('tickets-delete');
const NUMBER = 'TKT-0099-5521';

/** The member's ticket on the given item. */
const memberTicket = (w: TicketsWorld, itemId = w.ferry) =>
  createTicket(tdb.db, w.keys, {
    tripId: w.tripId,
    itemId,
    membershipId: w.member.membershipId,
    seat: '12A',
    ticketNo: NUMBER,
    baggage: { checked_kg: 20 },
  });

const rowOf = async (w: TicketsWorld, itemId = w.ferry) => (await ticketRows(tdb, itemId))[0];

describe('tickets.delete', () => {
  it('lets the item owner, organizers and the owner remove a ticket, soft, and bumps its version', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const ctx = as(w.organizer);
    await expect(w.tickets.delete(ctx, id, undefined, 1)).resolves.toBeUndefined();
    expect(await rowOf(w)).toMatchObject({
      version: 2,
      deleted_by: w.organizer.userId,
      deleted_at: expect.any(Date) as Date,
    });
    // The member owns the bus, so removes a ticket from it.
    const busTicket = await memberTicket(w, w.bus);
    await expect(w.tickets.delete(as(w.member), busTicket, undefined, 1)).resolves.toBeUndefined();
    const ferryTicket = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
    });
    await expect(w.tickets.delete(as(w.owner), ferryTicket, undefined, 1)).resolves.toBeUndefined();
    const { items } = await w.tickets.list(w.owner.userId, w.ferry, { limit: 50 });
    expect(items).toEqual([]);
  });

  it('refuses the passenger, other members and viewers', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(await refusal(w.tickets.delete(as(w.member), id, undefined, 1))).toBe('forbidden');
    expect(await refusal(w.tickets.delete(as(w.other), id, undefined, 1))).toBe('forbidden');
    expect(await refusal(w.tickets.delete(as(w.viewer), id, undefined, 1))).toBe('forbidden');
    expect((await rowOf(w))?.deleted_at).toBeNull();
  });

  it('answers not_found alike outside the trip, for a hidden item, a deleted ticket and an unknown id', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const hidden = await memberTicket(w, w.flight);
    const gone = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.bus,
      membershipId: w.other.membershipId,
      deleted: true,
    });
    expect(await refusal(w.tickets.delete(as(w.outsider), id, undefined, 1))).toBe('not_found');
    expect(await refusal(w.tickets.delete(as(w.owner), hidden, undefined, 1))).toBe('not_found');
    expect(await refusal(w.tickets.delete(as(w.viewer), hidden, undefined, 1))).toBe('not_found');
    expect(await refusal(w.tickets.delete(as(w.owner), gone, undefined, 1))).toBe('not_found');
    expect(
      await refusal(
        w.tickets.delete(as(w.owner), '0192f000-0000-7000-8000-00000000000a', undefined, 1),
      ),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.ferry);
    expect(await refusal(w.tickets.delete(as(w.owner), id, undefined, 1))).toBe('not_found');
  });

  it('takes If-Match = version: none is if_match_required, a stale one version_conflict', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(await refusal(w.tickets.delete(as(w.owner), id, undefined, undefined))).toBe(
      'if_match_required',
    );
    await w.tickets.update(as(w.owner), id, { seat: '1A' }, 1);
    expect(await refusal(w.tickets.delete(as(w.owner), id, undefined, 1))).toBe('version_conflict');
    expect((await rowOf(w))?.deleted_at).toBeNull();
  });

  it('refuses a body, since a delete takes none', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(await refusal(w.tickets.delete(as(w.owner), id, { seat: '1A' }, 1))).toBe(
      'validation_failed',
    );
  });

  it('refuses a second delete as not_found, and lets the passenger get a new ticket', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await w.tickets.delete(as(w.owner), id, undefined, 1);
    expect(await refusal(w.tickets.delete(as(w.owner), id, undefined, 2))).toBe('not_found');
    await expect(
      w.tickets.create(as(w.owner), w.ferry, {
        passenger: encodeTypeId(ID_PREFIX.membership, w.member.membershipId),
      }),
    ).resolves.toMatchObject({ passenger: w.member.membershipId });
  });

  it('records its audit event and entity_versions snapshot in the one transaction: the ticket as it was, number sealed', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const sealed = (await rowOf(w))?.ticket_no_enc ?? Buffer.alloc(0);
    const ctx = as(w.owner);
    await w.tickets.delete(ctx, id, undefined, 1);
    const written = await history(tdb, id);
    expect(written.events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'delete',
        entity_type: 'ticket',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      },
    ]);
    expect(written.snapshots).toEqual([
      {
        entity_type: 'ticket',
        version: 2,
        snapshot: {
          itemId: w.ferry,
          membershipId: w.member.membershipId,
          seat: '12A',
          baggage: { checkedKg: 20, cabinKg: null, addOns: [] },
          ticketNoEnc: sealed.toString('base64'),
        },
      },
    ]);
    const audit = JSON.stringify(
      await tdb.db.selectFrom('audit.audit_events').selectAll().execute(),
    );
    expect(audit).not.toContain(NUMBER);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await archive(tdb, w.tripId);
    expect(await refusal(w.tickets.delete(as(w.owner), id, undefined, 1))).toBe('trip_archived');
    expect((await rowOf(w))?.deleted_at).toBeNull();
  });
});
