// trips.list against the oracle: every account sees exactly the trips it is an active
// member of, and the harness fails when tribo.is_member stops checking that.
import { createTripsService, writePath } from '@tribo/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';

const options = leakRunOptions();

/** trips.list through the service, one page large enough for any generated world. */
const listTrips: ListRead = async (db, userId) => {
  const page = await createTripsService(db, writePath(db)).list(userId, { limit: 200 });
  return page.items.map((t) => t.id);
};

const property = (tdb: TestDatabase) =>
  listProperty(
    tdb.db,
    listTrips,
    (world) => world.trips.map((t) => t.id),
    (world, userId, tripId) => oracle.tripVisible(world, userId, tripId),
  );

describe('trips.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`lists exactly the caller's trips (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb), options);
  });
});

describe('mutation check: the harness catches a list that keeps removed members', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    // Break is_member in this database only: a removed member still counts as one.
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ def: string }>(
        `SELECT pg_get_functiondef('tribo.is_member(uuid, uuid)'::regprocedure) AS def`,
      );
      const def = rows[0]?.def ?? '';
      const broken = def.replace(/AND m\.deleted_at IS NULL/, '');
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
