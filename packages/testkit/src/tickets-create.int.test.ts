// @module-tag drop-b
// tickets.create (Drop B): Add ticket: passenger, seat, ticketNo, baggage; trip_archived on archived trips (R29)
// Through the tickets service and the real trips, items, crypto and audit modules: the ticket
// number is sealed in the row and nowhere else, only the item's managers add tickets, and a
// passenger is a live member of the item's trip with one ticket per item.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { open } from '@tribo/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createItem,
  createPlaceholder,
  createTicket,
  createUser,
  softDelete,
} from './factories.js';
import { ticketRows, ticketsWorld, type TicketsWorld } from './tickets-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const as = contexts('tickets-create');
const NUMBER = 'TKT-0099-5521';
const mem = (membershipId: string) => encodeTypeId(ID_PREFIX.membership, membershipId);

/** A full ticket for the member. */
const ticketFor = (w: TicketsWorld, overrides: Record<string, unknown> = {}) => ({
  passenger: mem(w.member.membershipId),
  seat: '12A',
  ticketNo: NUMBER,
  baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
  ...overrides,
});

describe('tickets.create', () => {
  it('adds a ticket for a passenger of the trip, the number answered masked', async () => {
    const w = await ticketsWorld(tdb);
    const ticket = await w.tickets.create(as(w.owner), w.ferry, ticketFor(w));
    expect(ticket).toEqual({
      id: expect.any(String) as string,
      itemId: w.ferry,
      passenger: w.member.membershipId,
      seat: '12A',
      ticketNo: 'masked',
      baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
      version: 1,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    expect(JSON.stringify(ticket)).not.toContain(NUMBER);
    const bare = await w.tickets.create(as(w.owner), w.ferry, {
      passenger: mem(w.other.membershipId),
    });
    expect(bare).toMatchObject({
      seat: null,
      ticketNo: null,
      baggage: { checkedKg: null, cabinKg: null, addOns: [] },
    });
  });

  it('seals the number in the row: the column is not the plaintext and opens only for that ticket', async () => {
    const w = await ticketsWorld(tdb);
    const ticket = await w.tickets.create(as(w.owner), w.ferry, ticketFor(w));
    const [row] = await ticketRows(tdb, w.ferry);
    const sealed = row?.ticket_no_enc ?? Buffer.alloc(0);
    expect(sealed.length).toBeGreaterThan(NUMBER.length);
    expect(sealed.toString('utf8')).not.toContain(NUMBER);
    expect(sealed.toString('base64')).not.toContain(Buffer.from(NUMBER).toString('base64'));
    const field = { table: 'tickets', column: 'ticket_no_enc', rowId: ticket.id };
    expect(open(w.keys, field, sealed).toString()).toBe(NUMBER);
    expect(() => open(w.keys, { ...field, rowId: w.ferry }, sealed)).toThrow();
    expect(row).toMatchObject({
      seat: '12A',
      baggage: { checked_kg: 20, cabin_kg: 7, add_ons: ['extra legroom'] },
      created_by: w.owner.userId,
      trip_id: w.tripId,
    });
  });

  it("lets the item's owner, organizers and the owner add tickets; refuses other members, passengers and viewers", async () => {
    const w = await ticketsWorld(tdb);
    // The member owns the bus: the item's owner adds tickets to it.
    await expect(
      w.tickets.create(as(w.member), w.bus, ticketFor(w, { passenger: mem(w.other.membershipId) })),
    ).resolves.toMatchObject({ passenger: w.other.membershipId });
    await expect(w.tickets.create(as(w.organizer), w.ferry, ticketFor(w))).resolves.toMatchObject({
      passenger: w.member.membershipId,
    });
    await expect(
      w.tickets.create(
        as(w.owner),
        w.ferry,
        ticketFor(w, { passenger: mem(w.other.membershipId) }),
      ),
    ).resolves.toMatchObject({ passenger: w.other.membershipId });
    // Being the passenger, or any other member, is not enough on the ferry; nor is a viewer.
    const mine = ticketFor(w, { passenger: mem(w.viewer.membershipId) });
    expect(await refusal(w.tickets.create(as(w.member), w.ferry, mine))).toBe('forbidden');
    expect(await refusal(w.tickets.create(as(w.other), w.ferry, mine))).toBe('forbidden');
    expect(await refusal(w.tickets.create(as(w.viewer), w.ferry, mine))).toBe('forbidden');
    expect(await ticketRows(tdb, w.ferry)).toHaveLength(2);
  });

  it('answers not_found outside the trip, for an item the caller cannot see, and for a deleted item', async () => {
    const w = await ticketsWorld(tdb);
    const body = ticketFor(w);
    expect(await refusal(w.tickets.create(as(w.outsider), w.ferry, body))).toBe('not_found');
    // The flight is private to another member: even the owner cannot see it, let alone add to it.
    expect(await refusal(w.tickets.create(as(w.owner), w.flight, body))).toBe('not_found');
    expect(await refusal(w.tickets.create(as(w.organizer), w.flight, body))).toBe('not_found');
    expect(
      await refusal(w.tickets.create(as(w.owner), '0192f000-0000-7000-8000-00000000000a', body)),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.ferry);
    expect(await refusal(w.tickets.create(as(w.owner), w.ferry, body))).toBe('not_found');
  });

  it('answers a hidden item exactly as an unknown one: not_found, before the role or the body is looked at', async () => {
    const w = await ticketsWorld(tdb);
    // A viewer would be forbidden and an invalid body validation_failed on a visible item.
    expect(await refusal(w.tickets.create(as(w.viewer), w.flight, {}))).toBe('not_found');
    expect(
      await refusal(w.tickets.create(as(w.viewer), '0192f000-0000-7000-8000-00000000000a', {})),
    ).toBe('not_found');
  });

  it('refuses a ticket on anything but a transport item', async () => {
    const w = await ticketsWorld(tdb);
    for (const itemId of [w.lodging, w.rental]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      expect(await refusal(w.tickets.create(as(w.owner), itemId, ticketFor(w)))).toBe(
        'validation_failed',
      );
    }
    const activity = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'activity',
    });
    expect(await refusal(w.tickets.create(as(w.owner), activity, ticketFor(w)))).toBe(
      'validation_failed',
    );
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const bodies: unknown[] = [
      {},
      { seat: '12A' },
      ticketFor(w, { passenger: w.member.membershipId }),
      ticketFor(w, { seat: '' }),
      ticketFor(w, { seat: 'x'.repeat(21) }),
      ticketFor(w, { ticketNo: '' }),
      ticketFor(w, { ticketNo: { masked: true } }),
      ticketFor(w, { baggage: { checkedKg: -1 } }),
      ticketFor(w, { baggage: { checkedKg: 101 } }),
      ticketFor(w, { baggage: { addOns: [''] } }),
      ticketFor(w, { baggage: { weight: 4 } }),
      ticketFor(w, { id: 'tkt_x' }),
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(w.tickets.create(as(w.owner), w.ferry, body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await ticketRows(tdb, w.ferry)).toHaveLength(0);
  });

  it('refuses a foreign, removed, deleted-trip or unknown passenger alike, naming the passenger field', async () => {
    const w = await ticketsWorld(tdb);
    const other = await ticketsWorld(tdb);
    const leaver = await createUser(tdb.db);
    const leaverMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaver.personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', leaverMembership);
    const passengers = [
      other.member.membershipId, // a member of another trip
      leaverMembership, // removed from this one
      '0192f000-0000-7000-8000-00000000000a', // nobody
    ];
    const errors: unknown[] = [];
    for (const passenger of passengers) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const error: unknown = await w.tickets
        .create(as(w.owner), w.ferry, ticketFor(w, { passenger: mem(passenger) }))
        .then(
          () => null,
          (e: unknown) => e,
        );
      errors.push(error);
    }
    const detail = (e: unknown) => JSON.stringify((e as { extra?: unknown }).extra ?? e);
    expect(new Set(errors.map(detail)).size).toBe(1);
    expect(detail(errors[0])).toContain('/passenger');
    expect(await ticketRows(tdb, w.ferry)).toHaveLength(0);
  });

  it("accepts a placeholder's membership as the passenger (decision 0007)", async () => {
    const w = await ticketsWorld(tdb);
    const personId = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    const membershipId = await addMember(tdb.db, { tripId: w.tripId, personId, role: 'member' });
    await expect(
      w.tickets.create(as(w.owner), w.ferry, ticketFor(w, { passenger: mem(membershipId) })),
    ).resolves.toMatchObject({ passenger: membershipId });
  });

  it('keeps one live ticket per passenger and item, and lets a deleted one be replaced', async () => {
    const w = await ticketsWorld(tdb);
    await w.tickets.create(as(w.owner), w.ferry, ticketFor(w));
    expect(await refusal(w.tickets.create(as(w.owner), w.ferry, ticketFor(w)))).toBe(
      'validation_failed',
    );
    // The same passenger on another item is fine.
    await expect(w.tickets.create(as(w.owner), w.bus, ticketFor(w))).resolves.toMatchObject({
      itemId: w.bus,
    });
    const gone = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
      deleted: true,
    });
    expect(gone).toBeDefined();
    await expect(
      w.tickets.create(
        as(w.owner),
        w.ferry,
        ticketFor(w, { passenger: mem(w.other.membershipId) }),
      ),
    ).resolves.toMatchObject({ passenger: w.other.membershipId });
  });

  it('lets exactly one of two concurrent creates for a passenger win, the other refused for its passenger', async () => {
    const w = await ticketsWorld(tdb);
    const results = await Promise.allSettled([
      w.tickets.create(as(w.owner), w.ferry, ticketFor(w)),
      w.tickets.create(as(w.organizer), w.ferry, ticketFor(w, { seat: '14C' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' ? (lost.reason as { code?: string }).code : null).toBe(
      'validation_failed',
    );
    expect(await ticketRows(tdb, w.ferry)).toHaveLength(1);
  });

  it('records its audit event and entity_versions snapshot in the one transaction, the number only sealed', async () => {
    const w = await ticketsWorld(tdb);
    const ctx = as(w.organizer);
    const ticket = await w.tickets.create(ctx, w.ferry, ticketFor(w));
    const written = await history(tdb, ticket.id);
    expect(written.events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'create',
        entity_type: 'ticket',
        version_before: null,
        version_after: 1,
        request_id: ctx.requestId,
      },
    ]);
    expect(written.snapshots).toEqual([
      {
        entity_type: 'ticket',
        version: 1,
        snapshot: {
          itemId: w.ferry,
          membershipId: w.member.membershipId,
          seat: '12A',
          baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
          ticketNoEnc: expect.any(String) as string,
        },
      },
    ]);
    const [row] = await ticketRows(tdb, w.ferry);
    const field = { table: 'tickets', column: 'ticket_no_enc', rowId: ticket.id };
    const sealed = Buffer.from(
      (written.snapshots[0]?.snapshot as { ticketNoEnc: string }).ticketNoEnc,
      'base64',
    );
    expect(sealed.equals(row?.ticket_no_enc ?? Buffer.alloc(0))).toBe(true);
    expect(open(w.keys, field, sealed).toString()).toBe(NUMBER);
    // Nothing the audit log holds, for any request, has the number or the seat in it.
    const audit = JSON.stringify(
      await tdb.db.selectFrom('audit.audit_events').selectAll().execute(),
    );
    expect(audit).not.toContain(NUMBER);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    await archive(tdb, w.tripId);
    expect(await refusal(w.tickets.create(as(w.owner), w.ferry, ticketFor(w)))).toBe(
      'trip_archived',
    );
    expect(await ticketRows(tdb, w.ferry)).toHaveLength(0);
  });
});
