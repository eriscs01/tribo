// @module-tag drop-b
// tickets.update (Drop B): Edit ticket; masked_field_write; trip_archived on archived trips (R29)
// Through the tickets service and the real trips, items, crypto and audit modules: whoever
// manages the item's tickets changes everything, a member only the seat and baggage of their
// own ticket, the number is re-sealed or kept and never answered, and a ticket the caller
// cannot see is as unknown.
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { open } from '@tribo/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTicket, createUser, softDelete } from './factories.js';
import { counted } from './overlays-world.js';
import { ticketRows, ticketsService, ticketsWorld, type TicketsWorld } from './tickets-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const as = contexts('tickets-update');
const NUMBER = 'TKT-0099-5521';
const NEW_NUMBER = 'TKT-7731-0042';
const mem = (membershipId: string) => encodeTypeId(ID_PREFIX.membership, membershipId);

/** The member's ticket on the ferry. */
async function memberTicket(w: TicketsWorld, itemId = w.ferry) {
  const id = await createTicket(tdb.db, w.keys, {
    tripId: w.tripId,
    itemId,
    membershipId: w.member.membershipId,
    seat: '12A',
    ticketNo: NUMBER,
    baggage: { checked_kg: 20, cabin_kg: 7, add_ons: ['extra legroom'] },
  });
  return id;
}

const rowOf = async (w: TicketsWorld, itemId = w.ferry) => (await ticketRows(tdb, itemId))[0];

describe('tickets.update', () => {
  it('lets the item owner, an organizer and the owner change everything, and answers the number masked', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const changed = await w.tickets.update(
      as(w.owner),
      id,
      {
        passenger: mem(w.other.membershipId),
        seat: '14C',
        ticketNo: NEW_NUMBER,
        baggage: { checkedKg: 30 },
      },
      1,
    );
    expect(changed).toEqual({
      id,
      itemId: w.ferry,
      passenger: w.other.membershipId,
      seat: '14C',
      ticketNo: 'masked',
      baggage: { checkedKg: 30, cabinKg: 7, addOns: ['extra legroom'] },
      version: 2,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    expect(JSON.stringify(changed)).not.toContain(NEW_NUMBER);
    const sealed = (await rowOf(w))?.ticket_no_enc ?? Buffer.alloc(0);
    expect(sealed.toString('utf8')).not.toContain(NEW_NUMBER);
    expect(
      open(w.keys, { table: 'tickets', column: 'ticket_no_enc', rowId: id }, sealed).toString(),
    ).toBe(NEW_NUMBER);
    // The organizer, and the member who owns another item, edit too.
    await expect(w.tickets.update(as(w.organizer), id, { seat: '1A' }, 2)).resolves.toMatchObject({
      seat: '1A',
      version: 3,
    });
    const busTicket = await memberTicket(w, w.bus);
    await expect(
      w.tickets.update(as(w.member), busTicket, { passenger: mem(w.viewer.membershipId) }, 1),
    ).resolves.toMatchObject({ passenger: w.viewer.membershipId });
  });

  it('keeps what a patch leaves out, clears with null, and keeps the sealed number untouched', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const before = (await rowOf(w))?.ticket_no_enc;
    const kept = await w.tickets.update(as(w.owner), id, { seat: null }, 1);
    expect(kept).toMatchObject({
      seat: null,
      ticketNo: 'masked',
      baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
    });
    expect((await rowOf(w))?.ticket_no_enc?.equals(before ?? Buffer.alloc(0))).toBe(true);
    const cleared = await w.tickets.update(
      as(w.owner),
      id,
      { ticketNo: null, baggage: { cabinKg: null, addOns: [] } },
      2,
    );
    expect(cleared).toMatchObject({
      ticketNo: null,
      baggage: { checkedKg: 20, cabinKg: null, addOns: [] },
    });
    expect((await rowOf(w))?.ticket_no_enc).toBeNull();
  });

  it('lets a member change the seat and baggage of their own ticket, and nothing else of it', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await expect(
      w.tickets.update(as(w.member), id, { seat: '12B', baggage: { cabinKg: 5 } }, 1),
    ).resolves.toMatchObject({ seat: '12B', baggage: { checkedKg: 20, cabinKg: 5 }, version: 2 });
    for (const body of [
      { ticketNo: NEW_NUMBER },
      { ticketNo: null },
      { ticketNo: { masked: true } },
      { passenger: mem(w.other.membershipId) },
      { passenger: mem(w.member.membershipId) },
      { seat: '1A', ticketNo: NEW_NUMBER },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      expect(await refusal(w.tickets.update(as(w.member), id, body, 2)), JSON.stringify(body)).toBe(
        'masked_field_write',
      );
    }
    const row = await rowOf(w);
    expect(row).toMatchObject({ seat: '12B', version: 2, membership_id: w.member.membershipId });
    expect(
      open(
        w.keys,
        { table: 'tickets', column: 'ticket_no_enc', rowId: id },
        row?.ticket_no_enc ?? Buffer.alloc(0),
      ).toString(),
    ).toBe(NUMBER);
  });

  it("refuses another member, a viewer and someone else's ticket, and a viewer their own", async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(await refusal(w.tickets.update(as(w.other), id, { seat: '1A' }, 1))).toBe('forbidden');
    expect(await refusal(w.tickets.update(as(w.viewer), id, { seat: '1A' }, 1))).toBe('forbidden');
    const viewerTicket = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.viewer.membershipId,
    });
    expect(await refusal(w.tickets.update(as(w.viewer), viewerTicket, { seat: '1A' }, 1))).toBe(
      'forbidden',
    );
    expect((await rowOf(w))?.seat).toBe('12A');
  });

  it('refuses a ticket number echoed back masked, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(
      await refusal(w.tickets.update(as(w.owner), id, { ticketNo: { masked: true } }, 1)),
    ).toBe('masked_field_write');
    expect((await rowOf(w))?.version).toBe(1);
  });

  it('takes If-Match = version: none is if_match_required, a stale one version_conflict', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    expect(await refusal(w.tickets.update(as(w.owner), id, { seat: '1A' }, undefined))).toBe(
      'if_match_required',
    );
    await w.tickets.update(as(w.owner), id, { seat: '1A' }, 1);
    expect(await refusal(w.tickets.update(as(w.owner), id, { seat: '2A' }, 1))).toBe(
      'version_conflict',
    );
    expect((await rowOf(w))?.seat).toBe('1A');
  });

  it('answers not_found alike for outsiders, hidden items, deleted items and tickets, unknown ids and removed passengers', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const hidden = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.flight,
      membershipId: w.member.membershipId,
    });
    const gone = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.bus,
      membershipId: w.other.membershipId,
      deleted: true,
    });
    const leaver = await createUser(tdb.db);
    const leaverMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaver.personId,
      role: 'member',
    });
    const leaversTicket = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: leaverMembership,
    });
    await softDelete(tdb.db, 'tribo.memberships', leaverMembership);
    const patch = { seat: '1A' };
    const unknown = '0192f000-0000-7000-8000-00000000000a';
    expect(await refusal(w.tickets.update(as(w.outsider), id, patch, 1))).toBe('not_found');
    expect(await refusal(w.tickets.update(as(w.owner), hidden, patch, 1))).toBe('not_found');
    expect(await refusal(w.tickets.update(as(w.viewer), hidden, {}, 1))).toBe('not_found');
    expect(await refusal(w.tickets.update(as(w.owner), gone, patch, 1))).toBe('not_found');
    expect(await refusal(w.tickets.update(as(w.owner), unknown, patch, 1))).toBe('not_found');
    expect(await refusal(w.tickets.update(as(w.owner), leaversTicket, patch, 1))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.ferry);
    expect(await refusal(w.tickets.update(as(w.owner), id, patch, 1))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const other = await ticketsWorld(tdb);
    const bodies: unknown[] = [
      { seat: '' },
      { seat: 'x'.repeat(21) },
      { ticketNo: '' },
      { baggage: { checkedKg: -1 } },
      { baggage: { addOns: [''] } },
      { baggage: null },
      { passenger: w.member.membershipId },
      { itemId: mem(w.owner.membershipId) },
      { version: 4 },
      // A passenger of another trip, or one who left.
      { passenger: mem(other.member.membershipId) },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      expect(await refusal(w.tickets.update(as(w.owner), id, body, 1)), JSON.stringify(body)).toBe(
        'validation_failed',
      );
    }
    expect((await rowOf(w))?.version).toBe(1);
  });

  it('keeps one live ticket per passenger and item: moving a ticket onto a passenger who has one is refused', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
    });
    expect(
      await refusal(w.tickets.update(as(w.owner), id, { passenger: mem(w.other.membershipId) }, 1)),
    ).toBe('validation_failed');
    // Keeping its own passenger is fine.
    await expect(
      w.tickets.update(as(w.owner), id, { passenger: mem(w.member.membershipId) }, 1),
    ).resolves.toMatchObject({ passenger: w.member.membershipId });
  });

  it('records its audit event and entity_versions snapshot in the one transaction, the number only sealed', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const ctx = as(w.organizer);
    await w.tickets.update(ctx, id, { seat: '1A', ticketNo: NEW_NUMBER }, 1);
    const written = await history(tdb, id);
    expect(written.events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'ticket',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      },
    ]);
    const [snapshot] = written.snapshots;
    expect(snapshot).toMatchObject({
      entity_type: 'ticket',
      version: 2,
      snapshot: {
        itemId: w.ferry,
        membershipId: w.member.membershipId,
        seat: '1A',
        baggage: { checkedKg: 20, cabinKg: 7, addOns: ['extra legroom'] },
      },
    });
    const sealed = Buffer.from(
      (snapshot?.snapshot as { ticketNoEnc: string }).ticketNoEnc,
      'base64',
    );
    expect(sealed.equals((await rowOf(w))?.ticket_no_enc ?? Buffer.alloc(0))).toBe(true);
    const everything = JSON.stringify([
      await tdb.db.selectFrom('audit.audit_events').selectAll().execute(),
      await tdb.db.selectFrom('tribo.entity_versions').select('snapshot').execute(),
    ]);
    expect(everything).not.toContain(NEW_NUMBER);
    expect(everything).not.toContain(NUMBER);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await archive(tdb, w.tripId);
    expect(await refusal(w.tickets.update(as(w.owner), id, { seat: '1A' }, 1))).toBe(
      'trip_archived',
    );
    expect(await refusal(w.tickets.update(as(w.member), id, { seat: '1A' }, 1))).toBe(
      'trip_archived',
    );
    expect((await rowOf(w))?.seat).toBe('12A');
  });

  it("costs the same queries to refuse a hidden ticket, a removed passenger's and an unknown one", async () => {
    const w = await ticketsWorld(tdb);
    const hidden = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.flight,
      membershipId: w.member.membershipId,
    });
    const leaver = await createUser(tdb.db);
    const leaverMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaver.personId,
      role: 'member',
    });
    const leaversTicket = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: leaverMembership,
    });
    await softDelete(tdb.db, 'tribo.memberships', leaverMembership);
    const queries: number[] = [];
    for (const id of [hidden, leaversTicket, '0192f000-0000-7000-8000-00000000000a']) {
      const { handle, state } = counted(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each counted alone
      expect(await refusal(ticketsService(handle, w.keys).update(as(w.owner), id, {}, 1))).toBe(
        'not_found',
      );
      queries.push(state.queries);
    }
    expect(new Set(queries).size).toBe(1);
    expect(queries[0]).toBeGreaterThan(0);
  });
});
