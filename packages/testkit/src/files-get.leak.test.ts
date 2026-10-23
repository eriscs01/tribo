// @module-tag drop-b
// files.get against the oracle: of every file in the world, an account reads exactly those
// the oracle shows it, and every other one answers not_found (never forbidden, which would
// say it exists).
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { blobDir, filesService, type BlobDir } from './files-world.js';
import { leakRunOptions, listProperty, oracle, type BuiltWorld, type ListRead } from './leak.js';

const options = leakRunOptions();
let dir: BlobDir;

/** files.get on every file row in the database; the ids it answered for. */
const getRead: ListRead = async (db, userId) => {
  const files = filesService(db, dir.blobs);
  const rows = await db.selectFrom('tribo.files').select('id').execute();
  const read: string[] = [];
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      read.push((await files.get(userId, row.id)).id);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return read;
};

const filesOf = (world: BuiltWorld) => world.trips.flatMap((t) => t.files.map((f) => f.id));

describe('files.get against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    dir = await blobDir();
  });
  afterAll(async () => {
    await dir.remove();
    await tdb.destroy();
  });

  const property = (read: ListRead) =>
    listProperty(tdb.db, read, filesOf, (world, userId, id) =>
      oracle.fileVisible(world, userId, id),
    );

  it(`reads exactly the files the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(getRead), options);
  });

  it('mutation check: the harness catches a get that ignores the file’s own visibility', async () => {
    const leaky: ListRead = async (db, userId) => {
      const fair = await getRead(db, userId);
      const privates = await db
        .selectFrom('tribo.files')
        .select('id')
        .where('visibility', '=', 'private')
        .where('deleted_at', 'is', null)
        .execute();
      return [...new Set([...fair, ...privates.map((f) => f.id)])];
    };
    expect((await fc.check(property(leaky), options)).failed).toBe(true);
  });
});
