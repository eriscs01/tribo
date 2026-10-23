// @module-tag drop-b
// files.download against the oracle: of every file in the world, an account gets the
// content of exactly those the oracle shows it (or file_purged, for a purged one it sees),
// not_found for every other one, and a reveal event only for sensitive files it got.
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { filesService, metadataOnlyBlobs } from './files-world.js';
import {
  leakRunOptions,
  listProperty,
  oracle,
  worldProperty,
  type BuiltWorld,
  type ListRead,
} from './leak.js';

const options = leakRunOptions();

let n = 0;

/** files.download on every file row; the ids it answered with content or file_purged. */
const downloadRead: ListRead = async (db, userId) => {
  const files = filesService(db, metadataOnlyBlobs);
  const rows = await db.selectFrom('tribo.files').select('id').execute();
  const seen: string[] = [];
  for (const row of rows) {
    n += 1;
    const ctx = { requestId: `files-download-leak-${String(n)}`, surface: 'web' as const, userId };
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      const { content } = await files.download(ctx, row.id);
      content.resume();
      seen.push(row.id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'file_purged') seen.push(row.id);
      else if (error.code !== 'not_found') throw error;
    }
  }
  return seen;
};

const filesOf = (world: BuiltWorld) => world.trips.flatMap((t) => t.files.map((f) => f.id));

describe('files.download against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const property = (read: ListRead) =>
    listProperty(tdb.db, read, filesOf, (world, userId, id) =>
      oracle.fileVisible(world, userId, id),
    );

  it(`downloads exactly the files the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(downloadRead), options);
  });

  it('records a reveal exactly for each sensitive, unpurged file a caller downloaded', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const problems: string[] = [];
        for (const userId of world.userIds) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
          await downloadRead(trx, userId);
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
          const events = await trx
            .selectFrom('audit.audit_events')
            .select('entity_id')
            .where('action', '=', 'reveal')
            .where('entity_type', '=', 'file')
            .where('actor_user_id', '=', userId)
            .execute();
          const revealed = events.map((e) => e.entity_id ?? '').sort();
          const expected = world.trips
            .flatMap((t) => t.files)
            .filter(
              (f) =>
                ['id', 'ticket', 'voucher'].includes(f.kind) &&
                !f.purged &&
                oracle.fileVisible(world, userId, f.id),
            )
            .map((f) => f.id)
            .sort();
          if (JSON.stringify(revealed) !== JSON.stringify(expected)) {
            problems.push(
              `${userId}: revealed ${JSON.stringify(revealed)}, expected ${JSON.stringify(expected)}`,
            );
          }
        }
        return problems;
      }),
      { ...options, numRuns: Math.ceil(options.numRuns / 4) },
    );
  });

  it('mutation check: the harness catches a download that ignores the item’s visibility', async () => {
    const leaky: ListRead = async (db, userId) => {
      const fair = await downloadRead(db, userId);
      const onItems = await db
        .selectFrom('tribo.files')
        .select('id')
        .where('deleted_at', 'is', null)
        .where('visibility', '=', 'shared')
        .where('item_id', 'is not', null)
        .execute();
      return [...new Set([...fair, ...onItems.map((f) => f.id)])];
    };
    expect((await fc.check(property(leaky), options)).failed).toBe(true);
  });
});
