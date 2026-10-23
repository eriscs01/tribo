// @module-tag drop-b
// files.list against the oracle: every account lists exactly the files it may see (the
// file's own visibility AND tribo.item_visible on its item; private and selected items,
// removed members, deleted trips, viewers), page after page, and the harness fails when the
// read stops hiding either.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { ApiError } from '@tribo/platform';
import type { DB } from '@tribo/db';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { blobDir, filesService, type BlobDir } from './files-world.js';
import { leakRunOptions, listProperty, oracle, type BuiltWorld, type ListRead } from './leak.js';

const options = leakRunOptions();
let dir: BlobDir;

/** files.list through its service for every trip, walking pages of `limit`; a trip not theirs lists nothing. */
function listRead(limit: number): ListRead {
  return async (db, userId) => {
    const files = filesService(db, dir.blobs);
    const trips = await db.selectFrom('tribo.trips').select('id').execute();
    const listed: string[] = [];
    for (const trip of trips) {
      let cursor: string | undefined;
      try {
        do {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
          const page = await files.list(userId, trip.id, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          listed.push(...page.items.map((f) => f.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
      }
    }
    return listed;
  };
}

const filesOf = (world: BuiltWorld) => world.trips.flatMap((t) => t.files.map((f) => f.id));

const listed = (db: Kysely<DB>, read: ListRead) =>
  listProperty(db, read, filesOf, (world, userId, id) => oracle.fileVisible(world, userId, id));

describe('files.list against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    dir = await blobDir();
  });
  afterAll(async () => {
    await dir.remove();
    await tdb.destroy();
  });

  it(`lists exactly the files the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listed(tdb.db, listRead(PAGE_LIMIT_MAX)), options);
  });

  it('pages one file at a time to the same files, so a cursor neither skips nor reveals one', async () => {
    await fc.assert(listed(tdb.db, listRead(1)), {
      ...options,
      numRuns: Math.ceil(options.numRuns / 4),
    });
  });

  it('mutation check: the harness catches a list that ignores the item’s visibility', async () => {
    const leaky: ListRead = async (db, userId) => {
      const fair = await listRead(PAGE_LIMIT_MAX)(db, userId);
      const onItems = await db
        .selectFrom('tribo.files')
        .select('id')
        .where('deleted_at', 'is', null)
        .where('visibility', '=', 'shared')
        .where('item_id', 'is not', null)
        .execute();
      return [...new Set([...fair, ...onItems.map((f) => f.id)])];
    };
    expect((await fc.check(listed(tdb.db, leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a list that shows other members’ private files', async () => {
    const leaky: ListRead = async (db, userId) => {
      const fair = await listRead(PAGE_LIMIT_MAX)(db, userId);
      const privates = await db
        .selectFrom('tribo.files')
        .select('id')
        .where('deleted_at', 'is', null)
        .where('visibility', '=', 'private')
        .where('item_id', 'is', null)
        .execute();
      return [...new Set([...fair, ...privates.map((f) => f.id)])];
    };
    expect((await fc.check(listed(tdb.db, leaky), options)).failed).toBe(true);
  });
});
