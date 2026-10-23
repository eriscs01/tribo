// @module-tag drop-b
// expenses.list against the oracle: every account lists exactly the expenses of the trips it
// is an active member of that are not voided (removed members, deleted trips and other
// trips list nothing), page after page; each shows its item only where the item shows to
// the caller, and its amounts only where the caller reads costs; and the ledger reads the
// same with every item hidden from the caller gone, so a hidden item shows by no count.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import type { ExpenseRecord } from '@tribo/core';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { expenseLeaks, expensesService } from './expenses-world.js';
import {
  leakRunOptions,
  listProperty,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type BuiltWorld,
} from './leak.js';

const options = leakRunOptions();

type ExpenseRead = (db: Kysely<DB>, userId: string) => Promise<ExpenseRecord[]>;

/** expenses.list through its service for every trip, walking pages of `limit`; a trip not theirs lists nothing. */
function listAll(limit: number): ExpenseRead {
  return async (db, userId) => {
    const expenses = expensesService(db);
    const trips = await db.selectFrom('tribo.trips').select('id').orderBy('id').execute();
    const listed: ExpenseRecord[] = [];
    for (const trip of trips) {
      let cursor: string | undefined;
      try {
        do {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
          const page = await expenses.list(userId, trip.id, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          listed.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
      }
    }
    return listed;
  };
}

const expensesOf = (world: BuiltWorld) => world.trips.flatMap((t) => t.expenses.map((e) => e.id));

describe('expenses.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const listsExactly = (read: ExpenseRead) =>
    listProperty(
      tdb.db,
      async (db, userId) => (await read(db, userId)).map((e) => e.id),
      expensesOf,
      (world, userId, id) => oracle.expenseVisible(world, userId, id),
    );

  const showsOnlyWhatItMay = (read: ExpenseRead) =>
    worldProperty(tdb.db, async (trx, world) => {
      const problems: string[] = [];
      for (const userId of world.userIds) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
        problems.push(...expenseLeaks(world, userId, await read(trx, userId)));
      }
      return problems;
    });

  it(`lists exactly the expenses the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listsExactly(listAll(PAGE_LIMIT_MAX)), options);
  });

  it('pages one expense at a time to the same expenses, so a cursor neither skips nor reveals one', async () => {
    await fc.assert(listsExactly(listAll(1)), {
      ...options,
      numRuns: Math.ceil(options.numRuns / 4),
    });
  });

  it('shows the item only where it shows, and amounts only to a caller who reads costs', async () => {
    await fc.assert(showsOnlyWhatItMay(listAll(PAGE_LIMIT_MAX)), options);
  });

  it('lists the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const problems: string[] = [];
        for (const userId of world.userIds) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () =>
            JSON.stringify(await listAll(PAGE_LIMIT_MAX)(trx, userId)),
          );
          if (before !== after) problems.push(`${userId}'s ledger changes with hidden items`);
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a ledger that keeps voided expenses', async () => {
    const leaky: ExpenseRead = async (db, userId) => {
      const fair = await listAll(PAGE_LIMIT_MAX)(db, userId);
      const voided = await db
        .selectFrom('tribo.expenses')
        .select('id')
        .where('deleted_at', 'is not', null)
        .execute();
      return [...fair, ...voided.map((v) => ({ ...fair[0], id: v.id }) as ExpenseRecord)];
    };
    expect((await fc.check(listsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a ledger that drops expenses on hidden items', async () => {
    const leaky: ExpenseRead = async (db, userId) => {
      const links = new Map(
        (await db.selectFrom('tribo.expenses').select(['id', 'item_id']).execute()).map((e) => [
          e.id,
          e.item_id,
        ]),
      );
      return (await listAll(PAGE_LIMIT_MAX)(db, userId)).filter(
        (e) => e.itemId !== null || (links.get(e.id) ?? null) === null,
      );
    };
    expect((await fc.check(listsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a ledger that unmasks the total for a viewer', async () => {
    const leaky: ExpenseRead = async (db, userId) =>
      (await listAll(PAGE_LIMIT_MAX)(db, userId)).map((e) => ({
        ...e,
        tripAmount: {
          amountMinor: 0,
          currency: 'PHP',
        },
      }));
    expect((await fc.check(showsOnlyWhatItMay(leaky), options)).failed).toBe(true);
  });
});
