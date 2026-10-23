// @module-tag drop-a
// members.list against the oracle: every account lists exactly the memberships the oracle
// allows, across trips it is in, was removed from, or that were deleted.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { memberItems, createMembersService, writePath } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';
import { testKeys } from './keys.js';

const options = leakRunOptions();

/**
 * members.list through its service for every trip in the world, one page large enough for
 * any generated trip; a trip the caller is not in answers not_found and lists nothing.
 */
const read: ListRead = async (db, userId) => {
  const members = createMembersService(db, writePath(db), testKeys(), memberItems);
  const trips = await db.selectFrom('tribo.trips').select('id').execute();
  const listed: string[] = [];
  for (const trip of trips) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const page = await members.list(userId, trip.id, { limit: PAGE_LIMIT_MAX });
      listed.push(...page.items.map((m) => m.id));
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
    (world) => world.trips.flatMap((t) => t.members.map((m) => m.id)),
    (world, userId, id) => oracle.memberVisible(world, userId, id),
  );

describe('members.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`lists exactly what the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb), options);
  });
});
