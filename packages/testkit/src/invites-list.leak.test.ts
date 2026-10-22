// @module-tag drop-a
// invites.list against the oracle: every account lists exactly the invite links the oracle
// allows (the owner's own trip's, revoked and expired ones included), and never a token.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { invitesService } from './invite-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';

const options = leakRunOptions();

/**
 * invites.list through its service for every trip in the world, one page large enough for
 * any generated trip; a trip the caller is not in answers not_found, and one they are in
 * but do not own answers forbidden: both list nothing.
 */
const read: ListRead = async (db, userId) => {
  const invites = invitesService({ db });
  const trips = await db.selectFrom('tribo.trips').select('id').execute();
  const listed: string[] = [];
  for (const trip of trips) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const page = await invites.list(userId, trip.id, { limit: PAGE_LIMIT_MAX });
      if (page.items.some((i) => 'token' in i || 'link' in i)) {
        throw new Error('invites.list returned a token');
      }
      listed.push(...page.items.map((i) => i.id));
    } catch (error) {
      if (!(error instanceof ApiError && ['not_found', 'forbidden'].includes(error.code))) {
        throw error;
      }
    }
  }
  return listed;
};

const property = (tdb: TestDatabase) =>
  listProperty(
    tdb.db,
    read,
    (world) => world.trips.flatMap((t) => t.invites.map((i) => i.id)),
    (world, userId, id) => oracle.inviteVisible(world, userId, id),
  );

describe('invites.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`lists exactly what the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb), options);
  });
});
