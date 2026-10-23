// @module-tag drop-b
// expenses.get against the oracle: of every expense in the world, an account reads exactly
// those of the trips it is an active member of that are not voided (removed members,
// deleted trips and other trips answer not_found); each shows its item only where the item
// shows to the caller, and its amounts only where the caller reads costs; and nothing it
// reads changes when every item hidden from it is gone.
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

/** expenses.get on every expense row in the database; what it answered. */
const getAll: ExpenseRead = async (db, userId) => {
  const expenses = expensesService(db);
  const rows = await db.selectFrom('tribo.expenses').select('id').orderBy('id').execute();
  const read: ExpenseRecord[] = [];
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      read.push(await expenses.get(userId, row.id));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return read;
};

const expensesOf = (world: BuiltWorld) => world.trips.flatMap((t) => t.expenses.map((e) => e.id));

describe('expenses.get against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const readsExactly = (read: ExpenseRead) =>
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

  it(`reads exactly the expenses the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(readsExactly(getAll), options);
  });

  it('shows the item only where it shows, and amounts only to a caller who reads costs', async () => {
    await fc.assert(showsOnlyWhatItMay(getAll), options);
  });

  it('reads the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const problems: string[] = [];
        for (const userId of world.userIds) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () =>
            JSON.stringify(await getAll(trx, userId)),
          );
          if (before !== after) problems.push(`${userId}'s expenses change with hidden items`);
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a get that answers voided expenses', async () => {
    const leaky: ExpenseRead = async (db, userId) => {
      const fair = await getAll(db, userId);
      const voided = await db
        .selectFrom('tribo.expenses')
        .select('id')
        .where('deleted_at', 'is not', null)
        .execute();
      return [...fair, ...voided.map((v) => ({ ...fair[0], id: v.id }) as ExpenseRecord)];
    };
    expect((await fc.check(readsExactly(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a get that shows the item it is on to everyone', async () => {
    const leaky: ExpenseRead = async (db, userId) => {
      const links = new Map(
        (await db.selectFrom('tribo.expenses').select(['id', 'item_id']).execute()).map((e) => [
          e.id,
          e.item_id,
        ]),
      );
      return (await getAll(db, userId)).map((e) => ({ ...e, itemId: links.get(e.id) ?? null }));
    };
    expect((await fc.check(showsOnlyWhatItMay(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a get that shows a share to a viewer without the grant', async () => {
    const leaky: ExpenseRead = async (db, userId) => {
      const shares = await db
        .selectFrom('tribo.expense_shares')
        .select(['expense_id', 'membership_id', 'share_minor'])
        .execute();
      return (await getAll(db, userId)).map((e) => ({
        ...e,
        shares: e.shares.map((s) => ({
          ...s,
          amount: {
            amountMinor: Number(
              shares.find((x) => x.expense_id === e.id && x.membership_id === s.membershipId)
                ?.share_minor,
            ),
            currency: 'PHP',
          },
        })),
      }));
    };
    expect((await fc.check(showsOnlyWhatItMay(leaky), options)).failed).toBe(true);
  });
});
