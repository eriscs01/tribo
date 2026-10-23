// @module-tag drop-b
// tickets.reveal against the oracle: of every ticket in the world (one for every membership on
// every transport item of its trip, some removed), an account gets the plaintext number of
// exactly those it may (the trip's owners and organizers any, a member their own), the right
// ticket's number and no other, with a reveal event for each and none for a refusal; every
// other ticket is not_found, a viewer's refusal is forbidden, and a ticket on an item the
// caller cannot see answers, and costs, exactly as one that is not there.
import { open } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { testKeys } from './keys.js';
import {
  leakRunOptions,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type BuiltWorld,
} from './leak.js';
import { activeMembership, counted } from './overlays-world.js';
import { seedTickets, ticketNumber, ticketsService, type SeededTicket } from './tickets-world.js';

/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
const options = leakRunOptions();
const keys = testKeys();
const body = { fields: ['ticketNo'] };

type Answer = { ticketNo: string | null } | { refused: string };
type Reveal = (db: Kysely<DB>, userId: string, ticketId: string) => Promise<unknown>;

let n = 0;
const fair: Reveal = (db, userId, ticketId) => {
  n += 1;
  return ticketsService(db, keys).reveal(
    { requestId: `tickets-reveal-leak-${String(n)}`, surface: 'web', userId },
    ticketId,
    body,
  );
};

async function answer(reveal: Reveal, db: Kysely<DB>, userId: string, ticketId: string) {
  try {
    return (await reveal(db, userId, ticketId)) as Answer;
  } catch (error) {
    if (error instanceof ApiError) return { refused: error.code } satisfies Answer;
    throw error;
  }
}

/** What the oracle says this caller gets for the ticket. */
function expected(world: BuiltWorld, ticket: SeededTicket, userId: string, tripId: string) {
  if (ticket.deleted || !oracle.itemVisible(world, userId, ticket.itemId)) {
    return { refused: 'not_found' };
  }
  const members = world.trips.flatMap((t) => t.members);
  if (members.find((m) => m.id === ticket.membershipId)?.deleted) return { refused: 'not_found' };
  const mine = activeMembership(world, userId, tripId);
  if (!mine) return { refused: 'not_found' };
  if (mine.role === 'viewer') return { refused: 'forbidden' };
  if (mine.role === 'member' && mine.id !== ticket.membershipId) return { refused: 'not_found' };
  return { ticketNo: ticketNumber(ticket.membershipId, ticket.itemId) };
}

const tripOf = (world: BuiltWorld, itemId: string) =>
  world.trips.find((t) => t.items.some((i) => i.id === itemId))?.id ?? '';

describe('tickets.reveal against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const revealsExactly = (reveal: Reveal) =>
    worldProperty(tdb.db, async (trx, world) => {
      const seeded = await seedTickets(trx, keys, world);
      const problems: string[] = [];
      for (const userId of world.userIds) {
        let granted = 0;
        for (const ticket of seeded) {
          const got = await answer(reveal, trx, userId, ticket.id);
          const want = expected(world, ticket, userId, tripOf(world, ticket.itemId));
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            problems.push(
              `${userId} on ${ticket.id}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
            );
          }
          if ('ticketNo' in want) granted += 1;
        }
        const events = await trx
          .selectFrom('audit.audit_events')
          .select('entity_id')
          .where('action', '=', 'reveal')
          .where('entity_type', '=', 'ticket')
          .where('actor_user_id', '=', userId)
          .execute();
        if (events.length !== granted) {
          problems.push(
            `${userId}: ${String(events.length)} reveal events for ${String(granted)} reveals`,
          );
        }
        if (JSON.stringify(events).includes('tkt-no:'))
          problems.push(`${userId}: a number in an event`);
      }
      return problems;
    });

  it(`reveals exactly what the caller may, each audited (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(revealsExactly(fair), options);
  });

  it('answers, and costs, the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const seeded = await seedTickets(trx, keys, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () => {
            const { handle, state } = counted(trx);
            const answers: Answer[] = [];
            for (const ticket of seeded)
              answers.push(await answer(fair, handle, userId, ticket.id));
            return JSON.stringify({ answers, queries: state.queries });
          });
          if (before !== after) problems.push(`${userId}'s reveals change with hidden items`);
        }
        return problems;
      }),
      { ...options, numRuns: Math.ceil(options.numRuns / 4) },
    );
  });

  it('is not vacuous: some world reveals a number to someone, and refuses another', async () => {
    let granted = 0;
    let refused = 0;
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const seeded = await seedTickets(trx, keys, world);
        for (const userId of world.userIds) {
          for (const ticket of seeded) {
            const want = expected(world, ticket, userId, tripOf(world, ticket.itemId));
            if ('ticketNo' in want) granted += 1;
            else refused += 1;
          }
        }
        return [];
      }),
      { ...options, numRuns: 20 },
    );
    expect(granted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('mutation check: the harness catches a reveal that skips the role and visibility checks', async () => {
    const leaky: Reveal = async (db, userId, ticketId) => {
      try {
        return await fair(db, userId, ticketId);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const row = await db
          .selectFrom('tribo.tickets')
          .select('ticket_no_enc')
          .where('id', '=', ticketId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!row?.ticket_no_enc) throw error;
        return {
          ticketNo: open(
            keys,
            { table: 'tickets', column: 'ticket_no_enc', rowId: ticketId },
            row.ticket_no_enc,
          ).toString(),
        };
      }
    };
    expect((await fc.check(revealsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a reveal that opens the number without the service, checks and event gone', async () => {
    const bypass: Reveal = async (db, _userId, ticketId) => {
      const row = await db
        .selectFrom('tribo.tickets')
        .select('ticket_no_enc')
        .where('id', '=', ticketId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row?.ticket_no_enc) throw new ApiError('not_found');
      return {
        ticketNo: open(
          keys,
          { table: 'tickets', column: 'ticket_no_enc', rowId: ticketId },
          row.ticket_no_enc,
        ).toString(),
      };
    };
    expect((await fc.check(revealsExactly(bypass), options)).failed).toBe(true);
  });
});
