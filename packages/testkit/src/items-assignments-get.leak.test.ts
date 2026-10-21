// @module-tag drop-a
// items.assignments.get against the oracle: every account reads exactly the board rows of
// the items it may see (children follow their item), and the harness fails when a read
// stops hiding them.
import { createUnitsService, writePath } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';

const options = leakRunOptions();

const key = (itemId: string, membershipId: string, role: string) =>
  `${itemId}:${membershipId}:${role}`;

/** items.assignments.get through its service for every item; a hidden item reads nothing. */
const read: ListRead = async (db, userId) => {
  const units = createUnitsService(db, writePath(db));
  const items = await db.selectFrom('tribo.items').select('id').execute();
  const rows: string[] = [];
  for (const item of items) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const board = await units.board(userId, item.id);
      rows.push(...board.allocations.map((a) => key(board.itemId, a.membershipId, a.role)));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return rows;
};

const property = (tdb: TestDatabase, boardRead: ListRead) =>
  listProperty(
    tdb.db,
    boardRead,
    (world) =>
      world.trips.flatMap((t) =>
        t.items.flatMap((i) => i.allocations.map((a) => key(i.id, a.membershipId, a.role))),
      ),
    (world, userId, id) => oracle.itemVisible(world, userId, id.split(':')[0] ?? ''),
  );

describe('items.assignments.get against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`reads exactly the board rows the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb, read), options);
  });

  it('mutation check: the harness catches a read that shows every board', async () => {
    const leaky: ListRead = async (db) =>
      (
        await db
          .selectFrom('tribo.allocations')
          .select(['item_id', 'membership_id', 'role'])
          .execute()
      ).map((a) => key(a.item_id, a.membership_id, a.role));
    const result = await fc.check(property(tdb, leaky), options);
    expect(result.failed).toBe(true);
  });
});
