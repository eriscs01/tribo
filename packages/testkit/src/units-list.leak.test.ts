// @module-tag drop-a
// units.list against the oracle: every account lists exactly the units of the items it may
// see, reads exactly the rates it may read, and the harness fails when a read stops hiding
// either.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { createUnitsService, writePath, type UnitRecord } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import type { DB } from '@tribo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type BuiltWorld, type ListRead } from './leak.js';

const options = leakRunOptions();

/** units.list through its service for every item in the world; a hidden item lists nothing. */
async function listedUnits(db: Kysely<DB>, userId: string): Promise<UnitRecord[]> {
  const units = createUnitsService(db, writePath(db));
  const items = await db.selectFrom('tribo.items').select('id').execute();
  const listed: UnitRecord[] = [];
  for (const item of items) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const page = await units.list(userId, item.id, { limit: PAGE_LIMIT_MAX });
      listed.push(...page.items);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return listed;
}

const unitsOf = (world: BuiltWorld) =>
  world.trips.flatMap((t) => t.items.flatMap((i) => i.units.map((u) => ({ item: i, unit: u }))));

const listRead: ListRead = async (db, userId) => (await listedUnits(db, userId)).map((u) => u.id);

/** The units whose rate the read showed as an amount. */
const rateRead: ListRead = async (db, userId) =>
  (await listedUnits(db, userId))
    .filter((u) => u.rate !== null && u.rate !== 'masked')
    .map((u) => u.id);

const listed = (tdb: TestDatabase, read: ListRead) =>
  listProperty(
    tdb.db,
    read,
    (world) => unitsOf(world).map(({ unit }) => unit.id),
    (world, userId, id) => oracle.unitVisible(world, userId, id),
  );

const rated = (tdb: TestDatabase, read: ListRead) =>
  listProperty(
    tdb.db,
    read,
    (world) =>
      unitsOf(world)
        .filter(({ unit }) => unit.priced)
        .map(({ unit }) => unit.id),
    (world, userId, id) => {
      const owner = unitsOf(world).find(({ unit }) => unit.id === id);
      return (
        owner !== undefined &&
        oracle.unitVisible(world, userId, id) &&
        oracle.moneyReadable(world, userId, owner.item.id)
      );
    },
  );

describe('units.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`lists exactly the units the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listed(tdb, listRead), options);
  });

  it('shows a rate exactly to the callers who may read the item’s money', async () => {
    await fc.assert(rated(tdb, rateRead), options);
  });

  it('mutation check: the harness catches a list that shows every live unit', async () => {
    const leaky: ListRead = async (db) =>
      (
        await db.selectFrom('tribo.units').select('id').where('deleted_at', 'is', null).execute()
      ).map((u) => u.id);
    const result = await fc.check(listed(tdb, leaky), options);
    expect(result.failed).toBe(true);
  });

  it('mutation check: the harness catches a list that shows every rate it lists', async () => {
    const leaky: ListRead = async (db, userId) => {
      const ids = await listRead(db, userId);
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom('tribo.units')
        .select('id')
        .where('id', 'in', ids)
        .where('rate_minor', 'is not', null)
        .execute();
      return rows.map((u) => u.id);
    };
    const result = await fc.check(rated(tdb, leaky), options);
    expect(result.failed).toBe(true);
  });
});
