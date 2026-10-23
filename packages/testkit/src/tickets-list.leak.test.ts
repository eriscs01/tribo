// @module-tag drop-b
// tickets.list against the oracle: of every ticket in the world (one for every membership on
// every transport item of its trip), an account lists exactly those on an item it sees, for
// passengers still in the trip and not removed, page after page; the ticket number never
// shows in any form, and a hidden item or a removed ticket shows by no value, code or query.
import type { Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { testKeys } from './keys.js';
import { leakRunOptions, oracle, withoutHiddenItems, worldProperty } from './leak.js';
import { counted } from './overlays-world.js';
import { seedTickets, ticketNumber, ticketsService, type SeededTicket } from './tickets-world.js';

/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
const options = leakRunOptions();
const keys: Keyring = testKeys();

type Answer = { ids: string[]; text: string } | { refused: string; text?: undefined };
type TicketRead = (db: Kysely<DB>, userId: string, itemId: string) => Promise<unknown[]>;

/** tickets.list through its service, walking pages of `limit`. */
function listAll(limit: number): TicketRead {
  return async (db, userId, itemId) => {
    const tickets = ticketsService(db, keys);
    const listed: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await tickets.list(userId, itemId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      listed.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return listed;
  };
}

/** What a read answered: the ticket ids and the text a marker can be looked for in, or its refusal. */
async function answer(read: TicketRead, db: Kysely<DB>, userId: string, itemId: string) {
  try {
    const listed = await read(db, userId, itemId);
    return {
      ids: listed.map((t) => (t as { id: string }).id).sort(),
      text: JSON.stringify(listed),
    } satisfies Answer;
  } catch (error) {
    if (error instanceof ApiError) return { refused: error.code } satisfies Answer;
    throw error;
  }
}

/** The ids the oracle lets this caller list on the item, or the refusal it gets. */
function expected(
  world: Parameters<typeof oracle.itemVisible>[0],
  seeded: SeededTicket[],
  userId: string,
  itemId: string,
) {
  if (!oracle.itemVisible(world, userId, itemId)) return { refused: 'not_found' };
  const members = world.trips.flatMap((t) => t.members);
  const present = (membershipId: string) => !members.find((m) => m.id === membershipId)?.deleted;
  return {
    ids: seeded
      .filter((t) => t.itemId === itemId && !t.deleted && present(t.membershipId))
      .map((t) => t.id)
      .sort(),
  };
}

const transportOf = (world: Parameters<typeof oracle.itemVisible>[0]) =>
  world.trips.flatMap((t) => t.items.filter((i) => i.type === 'transport').map((i) => i.id));

describe('tickets.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const listsExactly = (read: TicketRead) =>
    worldProperty(tdb.db, async (trx, world) => {
      const seeded = await seedTickets(trx, keys, world);
      const problems: string[] = [];
      for (const userId of world.userIds) {
        for (const itemId of transportOf(world)) {
          const got = await answer(read, trx, userId, itemId);
          const want = expected(world, seeded, userId, itemId);
          if ('refused' in want) {
            if (!('refused' in got) || got.refused !== want.refused) {
              problems.push(
                `${userId} on ${itemId}: wanted ${want.refused}, got ${JSON.stringify(got)}`,
              );
            }
          } else if (!('ids' in got) || JSON.stringify(got.ids) !== JSON.stringify(want.ids)) {
            problems.push(
              `${userId} on ${itemId}: wanted ${JSON.stringify(want.ids)}, got ${JSON.stringify(got)}`,
            );
          } else if ('text' in got && got.text.includes('tkt-no:')) {
            problems.push(`${userId} on ${itemId}: a ticket number shows`);
          }
        }
      }
      return problems;
    });

  it(`lists exactly what the caller may see, numbers masked (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listsExactly(listAll(200)), options);
  });

  it('pages one ticket at a time to the same tickets', async () => {
    await fc.assert(listsExactly(listAll(1)), {
      ...options,
      numRuns: Math.ceil(options.numRuns / 4),
    });
  });

  it('answers, and costs, the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedTickets(trx, keys, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () => {
            const { handle, state } = counted(trx);
            const answers: Answer[] = [];
            for (const itemId of transportOf(world)) {
              answers.push(await answer(listAll(200), handle, userId, itemId));
            }
            return JSON.stringify({ answers, queries: state.queries });
          });
          if (before !== after) problems.push(`${userId}'s reads change with hidden items`);
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a list that shows the sealed number', async () => {
    const leaky: TicketRead = async (db, userId, itemId) => {
      const fair = await listAll(200)(db, userId, itemId);
      return fair.map((t) => ({ ...(t as object), ticketNo: ticketNumber('x', 'y') }));
    };
    expect((await fc.check(listsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a list that ignores the item the ticket is on', async () => {
    const leaky: TicketRead = async (db, userId, itemId) => {
      try {
        return await listAll(200)(db, userId, itemId);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return await db
          .selectFrom('tribo.tickets')
          .select('id')
          .where('item_id', '=', itemId)
          .where('deleted_at', 'is', null)
          .execute();
      }
    };
    expect((await fc.check(listsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a list that keeps the tickets of passengers who left', async () => {
    const leaky: TicketRead = async (db, userId, itemId) => {
      await listAll(200)(db, userId, itemId);
      return await db
        .selectFrom('tribo.tickets')
        .select('id')
        .where('item_id', '=', itemId)
        .where('deleted_at', 'is', null)
        .execute();
    };
    expect((await fc.check(listsExactly(leaky), options)).failed).toBe(true);
  });

  it('is not vacuous: some world lists a ticket to someone', async () => {
    let listed = 0;
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const seeded = await seedTickets(trx, keys, world);
        for (const userId of world.userIds) {
          for (const itemId of transportOf(world)) {
            listed += expected(world, seeded, userId, itemId).ids?.length ?? 0;
          }
        }
        return [];
      }),
      { ...options, numRuns: 20 },
    );
    expect(listed).toBeGreaterThan(0);
  });
});
