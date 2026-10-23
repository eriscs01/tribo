// @module-tag drop-b
// tickets.list (Drop B): Per-passenger tickets of a transport item; ticketNo masked for all; follows item_visible
// Through the tickets service and the real trips and items modules: every role reads the
// item's tickets with the ticket number masked, an item the caller cannot see answers like
// an unknown one, and tickets of removed passengers, deleted tickets and other items stay out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTicket, createUser, softDelete } from './factories.js';
import { ticketsWorld, type TicketsWorld } from './tickets-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const PAGE = { limit: 50 };

/** The member's ticket on the ferry, with a number, a seat and baggage. */
function memberTicket(w: TicketsWorld, init: { deleted?: boolean; itemId?: string } = {}) {
  return createTicket(tdb.db, w.keys, {
    tripId: w.tripId,
    itemId: init.itemId ?? w.ferry,
    membershipId: w.member.membershipId,
    seat: '12A',
    ticketNo: 'TKT-0099-5521',
    baggage: { checked_kg: 20, cabin_kg: 7, add_ons: ['extra legroom'] },
    ...(init.deleted === undefined ? {} : { deleted: init.deleted }),
  });
}

describe('tickets.list', () => {
  it("answers the item's tickets with the ticket number masked, baggage normalised and ids", async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const bare = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
    });
    const answer = await w.tickets.list(w.member.userId, w.ferry, PAGE);
    expect(answer.nextCursor).toBeNull();
    expect(answer.items).toEqual([
      {
        id,
        itemId: w.ferry,
        passenger: w.member.membershipId,
        seat: '12A',
        ticketNo: 'masked',
        baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
        version: 1,
        createdAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
      },
      {
        id: bare,
        itemId: w.ferry,
        passenger: w.other.membershipId,
        seat: null,
        ticketNo: null,
        baggage: { checkedKg: null, cabinKg: null, addOns: [] },
        version: 1,
        createdAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain('TKT-0099');
  });

  it("masks the ticket number for everyone, the passenger and the item's owner included", async () => {
    const w = await ticketsWorld(tdb);
    await memberTicket(w);
    for (const who of [w.owner, w.organizer, w.member, w.other, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const { items } = await w.tickets.list(who.userId, w.ferry, PAGE);
      expect(items.map((t) => t.ticketNo)).toEqual(['masked']);
    }
  });

  it('lists the same tickets to every role the operation allows, a viewer included', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    for (const who of [w.owner, w.organizer, w.member, w.other, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const { items } = await w.tickets.list(who.userId, w.ferry, PAGE);
      expect(items.map((t) => t.id)).toEqual([id]);
    }
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await ticketsWorld(tdb);
    await memberTicket(w);
    expect(await refusal(w.tickets.list(w.outsider.userId, w.ferry, PAGE))).toBe('not_found');
    const v = await ticketsWorld(tdb);
    await memberTicket(v);
    await softDelete(tdb.db, 'tribo.memberships', v.member.membershipId);
    expect(await refusal(v.tickets.list(v.member.userId, v.ferry, PAGE))).toBe('not_found');
    const t = await ticketsWorld(tdb);
    await memberTicket(t);
    await softDelete(tdb.db, 'tribo.trips', t.tripId);
    expect(await refusal(t.tickets.list(t.member.userId, t.ferry, PAGE))).toBe('not_found');
  });

  it('answers not_found for an item the caller cannot see, as for an unknown or deleted one', async () => {
    const w = await ticketsWorld(tdb);
    await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.flight,
      membershipId: w.other.membershipId,
      seat: '3C',
    });
    expect(await refusal(w.tickets.list(w.owner.userId, w.flight, PAGE))).toBe('not_found');
    expect(await refusal(w.tickets.list(w.viewer.userId, w.flight, PAGE))).toBe('not_found');
    expect(
      await refusal(w.tickets.list(w.owner.userId, '0192f000-0000-7000-8000-00000000000a', PAGE)),
    ).toBe('not_found');
    expect((await w.tickets.list(w.other.userId, w.flight, PAGE)).items).toHaveLength(1);
    await softDelete(tdb.db, 'tribo.items', w.ferry);
    expect(await refusal(w.tickets.list(w.owner.userId, w.ferry, PAGE))).toBe('not_found');
  });

  it("leaves out deleted tickets, a removed passenger's and another item's", async () => {
    const w = await ticketsWorld(tdb);
    const kept = await memberTicket(w);
    await memberTicket(w, { deleted: true });
    await memberTicket(w, { itemId: w.bus });
    const leaver = await createUser(tdb.db);
    const leaverMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaver.personId,
      role: 'member',
    });
    await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: leaverMembership,
      seat: '1A',
    });
    await softDelete(tdb.db, 'tribo.memberships', leaverMembership);
    const { items } = await w.tickets.list(w.owner.userId, w.ferry, PAGE);
    expect(items.map((t) => t.id)).toEqual([kept]);
  });

  it('pages in the order tickets were added, with an opaque cursor', async () => {
    const w = await ticketsWorld(tdb);
    const first = await memberTicket(w);
    const second = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
    });
    const one = await w.tickets.list(w.owner.userId, w.ferry, { limit: 1 });
    expect(one.items.map((t) => t.id)).toEqual([first]);
    expect(one.nextCursor).not.toBeNull();
    const two = await w.tickets.list(w.owner.userId, w.ferry, {
      limit: 1,
      cursor: one.nextCursor ?? '',
    });
    expect(two.items.map((t) => t.id)).toEqual([second]);
    expect(two.nextCursor).toBeNull();
  });
});
