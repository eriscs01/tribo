// @module-tag drop-a
// library.search against the oracle: every account finds exactly the people
// tribo.person_visible lets it see (self, its placeholders, co-members of live trips).
import { createLibraryService, writePath } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, listProperty, oracle, type ListRead } from './leak.js';

const options = leakRunOptions();
const keys = keyring(new AppKey(randomBytes(32)));

/**
 * library.search through its service, for a query every generated name matches ("User n",
 * "Guest n"), with a limit above any generated world's person count.
 */
const read: ListRead = async (db, userId) => {
  const hits = await createLibraryService(db, writePath(db), keys).search(userId, {
    q: 'e',
    limit: 50,
  });
  return hits.filter((hit) => hit.kind === 'person').map((hit) => hit.id);
};

const property = (tdb: TestDatabase) =>
  listProperty(
    tdb.db,
    read,
    (world) => world.persons.map((p) => p.id),
    (world, userId, personId) => oracle.personVisible(world, userId, personId),
  );

describe('library.search against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`finds exactly the people the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb), options);
  });
});
