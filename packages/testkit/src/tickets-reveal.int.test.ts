// @module-tag drop-b
// tickets.reveal (Drop B): Plaintext ticketNo; Audited reveal; never cached offline; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Allowed on archived trips (a read, audited); refused with trip_retired after retirement
// Through the tickets service and the real trips, items, crypto and audit modules: the plaintext
// number leaves the database only here, for the trip's owners and organizers and the passenger,
// each call writing its own reveal event that names the field and never the value.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTicket, createUser, softDelete } from './factories.js';
import { counted } from './overlays-world.js';
import { ticketsService, ticketsWorld, type TicketsWorld } from './tickets-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const as = contexts('tickets-reveal');
const NUMBER = 'TKT-0099-5521';
const body = { fields: ['ticketNo'] };

/** The member's ticket on the given item, with a number. */
const memberTicket = (w: TicketsWorld, itemId = w.ferry, ticketNo: string | null = NUMBER) =>
  createTicket(tdb.db, w.keys, {
    tripId: w.tripId,
    itemId,
    membershipId: w.member.membershipId,
    seat: '12A',
    ticketNo,
  });

const reveals = (ticketId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('entity_id', '=', ticketId)
    .where('action', '=', 'reveal')
    .orderBy('seq')
    .execute();

describe('tickets.reveal', () => {
  it('returns the plaintext number to the owner, an organizer and the passenger', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    for (const user of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      expect(await w.tickets.reveal(as(user), id, body)).toEqual({ ticketNo: NUMBER });
    }
  });

  it('answers null when no number is stored', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w, w.ferry, null);
    expect(await w.tickets.reveal(as(w.member), id, body)).toEqual({ ticketNo: null });
  });

  it("refuses a viewer, even for their own ticket, and answers another member's ticket as an unknown one", async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const viewersOwn = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.viewer.membershipId,
      ticketNo: 'VIEWER-1',
    });
    expect(await refusal(w.tickets.reveal(as(w.viewer), id, body))).toBe('forbidden');
    expect(await refusal(w.tickets.reveal(as(w.viewer), viewersOwn, body))).toBe('forbidden');
    expect(await refusal(w.tickets.reveal(as(w.other), id, body))).toBe('not_found');
    // Owning the item is not owning the ticket: the bus is the member's, the ticket is other's.
    const busTicket = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.bus,
      membershipId: w.other.membershipId,
      ticketNo: 'BUS-1',
    });
    expect(await refusal(w.tickets.reveal(as(w.member), busTicket, body))).toBe('not_found');
    expect(
      await refusal(w.tickets.reveal(as(w.other), '0192f000-0000-7000-8000-00000000000a', body)),
    ).toBe('not_found');
    expect(await reveals(id)).toEqual([]);
    expect(await reveals(busTicket)).toEqual([]);
  });

  it('answers not_found alike outside the trip, for a hidden item, a deleted ticket, item or trip and a removed passenger', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const hidden = await memberTicket(w, w.flight);
    const gone = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.bus,
      membershipId: w.member.membershipId,
      ticketNo: 'GONE-1',
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
      ticketNo: 'LEFT-1',
    });
    await softDelete(tdb.db, 'tribo.memberships', leaverMembership);
    expect(await refusal(w.tickets.reveal(as(w.outsider), id, body))).toBe('not_found');
    expect(await refusal(w.tickets.reveal(as(w.owner), hidden, body))).toBe('not_found');
    expect(await refusal(w.tickets.reveal(as(w.viewer), hidden, body))).toBe('not_found');
    expect(await refusal(w.tickets.reveal(as(w.owner), gone, body))).toBe('not_found');
    expect(await refusal(w.tickets.reveal(as(w.owner), leaversTicket, body))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.ferry);
    expect(await refusal(w.tickets.reveal(as(w.owner), id, body))).toBe('not_found');
    const t = await ticketsWorld(tdb);
    const tripTicket = await memberTicket(t);
    await softDelete(tdb.db, 'tribo.trips', t.tripId);
    expect(await refusal(t.tickets.reveal(as(t.owner), tripTicket, body))).toBe('not_found');
    for (const ticketId of [id, hidden, gone, leaversTicket]) {
      // eslint-disable-next-line no-await-in-loop -- each count is read on its own
      expect(await reveals(ticketId)).toEqual([]);
    }
  });

  it("costs the same queries to refuse a hidden ticket, another member's and an unknown one", async () => {
    const w = await ticketsWorld(tdb);
    const hidden = await memberTicket(w, w.flight);
    const others = await memberTicket(w);
    const queries: number[] = [];
    for (const [user, id] of [
      [w.owner, hidden],
      [w.other, others],
      [w.owner, '0192f000-0000-7000-8000-00000000000a'],
    ] as const) {
      const { handle, state } = counted(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each counted alone
      expect(await refusal(ticketsService(handle, w.keys).reveal(as(user), id, body))).toBe(
        'not_found',
      );
      queries.push(state.queries);
    }
    expect(new Set(queries).size).toBe(1);
    expect(queries[0]).toBeGreaterThan(0);
  });

  it('refuses an invalid body with validation_failed, revealing and recording nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    for (const bad of [
      {},
      { fields: [] },
      { fields: ['seat'] },
      { fields: ['ticketNo', 'ticketNo'] },
      { fields: ['ticketNo'], extra: true },
      null,
      undefined,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      expect(await refusal(w.tickets.reveal(as(w.member), id, bad)), JSON.stringify(bad)).toBe(
        'validation_failed',
      );
    }
    expect(await reveals(id)).toEqual([]);
  });

  it('records a reveal event naming the field, never the value, and no snapshot', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    const versions = () =>
      tdb.db
        .selectFrom('tribo.entity_versions')
        .select('version')
        .where('entity_id', '=', id)
        .execute();
    const ctx = as(w.organizer);
    await w.tickets.reveal(ctx, id, body);
    const [event, ...rest] = await reveals(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      chain_key: `trip:${w.tripId}`,
      action: 'reveal',
      entity_type: 'ticket',
      trip_id: w.tripId,
      actor_user_id: w.organizer.userId,
      request_id: ctx.requestId,
      reason: '/ticketNo',
      version_before: null,
      version_after: null,
    });
    expect(JSON.stringify(event)).not.toContain(NUMBER);
    expect(await versions()).toEqual([]);
  });

  it('is never replayed: each call is its own audited reveal (R2)', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await w.tickets.reveal(as(w.member), id, body);
    await w.tickets.reveal(as(w.member), id, body);
    await w.tickets.reveal(as(w.owner), id, body);
    expect(await reveals(id)).toHaveLength(3);
  });

  it("reveals the number of the ticket asked for, never another passenger's", async () => {
    const w = await ticketsWorld(tdb);
    const mine = await memberTicket(w);
    const theirs = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
      ticketNo: 'OTHER-7788',
    });
    expect(await w.tickets.reveal(as(w.owner), mine, body)).toEqual({ ticketNo: NUMBER });
    expect(await w.tickets.reveal(as(w.owner), theirs, body)).toEqual({ ticketNo: 'OTHER-7788' });
  });

  it('works on an archived trip (a read, audited)', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await archive(tdb, w.tripId);
    expect(await w.tickets.reveal(as(w.member), id, body)).toEqual({ ticketNo: NUMBER });
    expect(await reveals(id)).toHaveLength(1);
  });

  it('answers trip_retired once the audit chain is retired, revealing nothing', async () => {
    const w = await ticketsWorld(tdb);
    const id = await memberTicket(w);
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date(), audit_retired_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(await refusal(w.tickets.reveal(as(w.member), id, body))).toBe('trip_retired');
    expect(await reveals(id)).toEqual([]);
  });

  it("fails loudly, not with another ticket's number, when the stored number does not open for its ticket", async () => {
    const w = await ticketsWorld(tdb);
    const first = await memberTicket(w);
    const second = await createTicket(tdb.db, w.keys, {
      tripId: w.tripId,
      itemId: w.ferry,
      membershipId: w.other.membershipId,
      ticketNo: 'OTHER-7788',
    });
    // Copy the second ticket's sealed number onto the first: it is bound to the second's id.
    const swapped = await tdb.db
      .selectFrom('tribo.tickets')
      .select('ticket_no_enc')
      .where('id', '=', second)
      .executeTakeFirstOrThrow();
    await tdb.db
      .updateTable('tribo.tickets')
      .set({ ticket_no_enc: swapped.ticket_no_enc })
      .where('id', '=', first)
      .execute();
    const error: unknown = await w.tickets.reveal(as(w.owner), first, body).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('OTHER-7788');
    expect(await reveals(first)).toEqual([]);
  });
});
