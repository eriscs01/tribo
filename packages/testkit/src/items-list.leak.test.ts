// @module-tag drop-a
// items.list against the oracle: every account lists exactly the items the oracle allows,
// and the harness fails when tribo.item_visible stops checking the owner of private items.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { createItemsService, writePath } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';
import { testKeys } from './keys.js';

const options = leakRunOptions();

/**
 * items.list through its service for every trip in the world, one page large enough for
 * any generated trip; a trip the caller is not in answers not_found and lists nothing.
 */
const read: ListRead = async (db, userId) => {
  const items = createItemsService(db, writePath(db), testKeys());
  const trips = await db.selectFrom('tribo.trips').select('id').execute();
  const listed: string[] = [];
  for (const trip of trips) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const page = await items.list(userId, trip.id, { limit: PAGE_LIMIT_MAX });
      listed.push(...page.items.map((i) => i.id));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return listed;
};

const property = (tdb: TestDatabase) =>
  listProperty(
    tdb.db,
    read,
    (world) => world.trips.flatMap((t) => t.items.map((i) => i.id)),
    (world, userId, id) => oracle.itemVisible(world, userId, id),
  );

describe('items.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`lists exactly what the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb), options);
  });
});

describe('mutation check: the harness catches a list that shows private items to everyone', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    // Break item_visible in this database only: a private item counts as shared.
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ def: string }>(
        `SELECT pg_get_functiondef('tribo.item_visible(uuid, uuid)'::regprocedure) AS def`,
      );
      const def = rows[0]?.def ?? '';
      const broken = def.replace(/i\.visibility = 'shared'/, `i.visibility <> 'selected'`);
      expect(broken).not.toBe(def);
      await owner.query(broken);
    } finally {
      await owner.end();
    }
  });
  afterAll(() => tdb.destroy());

  it('fails the property', async () => {
    const result = await fc.check(property(tdb), options);
    expect(result.failed).toBe(true);
  });
});
