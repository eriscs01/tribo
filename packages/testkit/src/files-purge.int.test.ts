// @module-tag drop-b
// The retention purge (Technical design, "Retention"; decision 0023), through the documents
// service and a real blob store: which files are due after document_retention_days, that a
// purge deletes only the blob its row names, leaves a content-free tombstone, is safe to
// run again, and that one file failing stops neither the others nor the next run.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileRecord, FilesService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createTrip } from './factories.js';
import {
  blobDir,
  fileRow,
  filesService,
  filesWorld,
  part,
  sample,
  type BlobDir,
} from './files-world.js';

let tdb: TestDatabase;
let dir: BlobDir;
let files: FilesService;
const as = contexts('files-purge');
let runs = 0;
const job = (): RequestContext => {
  runs += 1;
  return { requestId: `job-files-purge-${String(runs)}`, surface: 'system', userId: null };
};
const ignore = () => undefined;

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});
beforeEach(async () => {
  // Every test starts from the default and from no file due elsewhere in the database.
  await tdb.db
    .updateTable('tribo.platform_settings')
    .set({ document_retention_days: 30 })
    .execute();
  await purgeAll();
});

/** Purges whatever earlier tests left due, so each test counts only its own files. */
async function purgeAll() {
  await files.purgeDue(job(), ignore);
}

type World = Awaited<ReturnType<typeof filesWorld>>;

async function uploaded(w: World, kind: 'photo' | 'ticket' = 'photo'): Promise<FileRecord> {
  return files.upload(
    as(w.member),
    w.tripId,
    { kind },
    part(sample('pdf'), { filename: 'Secret name.pdf' }),
  );
}

const blobOf = async (fileId: string) => (await fileRow(tdb, fileId))?.blob_key ?? '';

/** Moves a soft delete (of a file or a trip) `days` into the past. */
async function deletedDaysAgo(table: 'tribo.files' | 'tribo.trips', id: string, days: number) {
  await tdb.db
    .updateTable(table)
    .set({ deleted_at: sql<Date>`now() - make_interval(days => ${days})` })
    .where('id', '=', id)
    .execute();
}

describe('the file retention purge', () => {
  it('purges a file deleted at least document_retention_days ago, and keeps a newer one', async () => {
    const w = await filesWorld(tdb);
    const old = await uploaded(w);
    const recent = await uploaded(w);
    await files.delete(as(w.member), old.id, undefined, 1);
    await files.delete(as(w.member), recent.id, undefined, 1);
    await deletedDaysAgo('tribo.files', old.id, 30);
    await deletedDaysAgo('tribo.files', recent.id, 29);
    const oldBlob = await blobOf(old.id);
    const recentBlob = await blobOf(recent.id);

    expect(await files.purgeDue(job(), ignore)).toEqual({ due: 1, purged: 1, failed: 0 });
    expect(await fileRow(tdb, old.id)).toMatchObject({
      filename: 'purged',
      purged_at: expect.any(Date) as Date,
      version: 3,
      blob_key: oldBlob,
    });
    expect(await dir.stored()).not.toContain(oldBlob);
    expect(await dir.stored()).toContain(recentBlob);
    expect((await fileRow(tdb, recent.id))?.purged_at).toBeNull();
  });

  it('leaves a content-free tombstone: the purge event and the only snapshot left hold no name', async () => {
    const w = await filesWorld(tdb);
    const file = await uploaded(w);
    await files.update(as(w.member), file.id, { filename: 'Another secret.pdf' }, 1);
    await files.delete(as(w.member), file.id, undefined, 2);
    await deletedDaysAgo('tribo.files', file.id, 31);
    const ctx = job();
    await files.purgeDue(ctx, ignore);
    const { events, snapshots } = await history(tdb, file.id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'purge',
      entity_type: 'file',
      version_before: 3,
      version_after: 4,
      request_id: ctx.requestId,
    });
    expect(snapshots).toEqual([
      {
        entity_type: 'file',
        version: 4,
        snapshot: {
          tripId: w.tripId,
          itemId: null,
          ownerMembershipId: w.member.membershipId,
          kind: 'photo',
          visibility: 'shared',
          filename: 'purged',
        },
      },
    ]);
    expect(JSON.stringify(snapshots)).not.toContain('secret');
    const reasons = await tdb.db
      .selectFrom('audit.audit_events')
      .select('reason')
      .where('entity_id', '=', file.id)
      .execute();
    expect(reasons.every((r) => r.reason === null)).toBe(true);
  });

  it('purges every file of a trip deleted at least document_retention_days ago', async () => {
    const w = await filesWorld(tdb);
    const live = await uploaded(w);
    const fresh = await filesWorld(tdb);
    const kept = await uploaded(fresh);
    await deletedDaysAgo('tribo.trips', w.tripId, 30);
    await deletedDaysAgo('tribo.trips', fresh.tripId, 2);
    expect(await files.purgeDue(job(), ignore)).toMatchObject({ purged: 1, failed: 0 });
    expect((await fileRow(tdb, live.id))?.purged_at).toBeInstanceOf(Date);
    expect((await fileRow(tdb, kept.id))?.purged_at).toBeNull();
  });

  it('purges a sensitive file once its trip ended document_retention_days ago, not the others', async () => {
    const w = await filesWorld(tdb);
    const ticket = await uploaded(w, 'ticket');
    const photo = await uploaded(w);
    const ending = await filesWorld(tdb);
    const later = await uploaded(ending, 'ticket');
    // The first trip ended 31 days ago; the second ends today.
    await tdb.db
      .updateTable('tribo.trips')
      .set({
        start_date: sql<string>`current_date - 35`,
        end_date: sql<string>`current_date - 31`,
      })
      .where('id', '=', w.tripId)
      .execute();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ start_date: sql<string>`current_date - 3`, end_date: sql<string>`current_date` })
      .where('id', '=', ending.tripId)
      .execute();
    expect(await files.purgeDue(job(), ignore)).toMatchObject({ purged: 1 });
    expect((await fileRow(tdb, ticket.id))?.purged_at).toBeInstanceOf(Date);
    expect((await fileRow(tdb, photo.id))?.purged_at).toBeNull();
    expect((await fileRow(tdb, later.id))?.purged_at).toBeNull();
    // A purged file still shows, as purged, and its bytes are gone for good.
    expect(await files.get(w.member.userId, ticket.id)).toMatchObject({ filename: 'purged' });
    expect(await refusal(files.download(as(w.member), ticket.id))).toBe('file_purged');
  });

  it('reads document_retention_days from the platform settings', async () => {
    const w = await filesWorld(tdb);
    const file = await uploaded(w);
    await files.delete(as(w.member), file.id, undefined, 1);
    expect(await files.purgeDue(job(), ignore)).toMatchObject({ purged: 0 });
    // At 0 days every deleted file is due at once, earlier tests' recent deletes included.
    await tdb.db
      .updateTable('tribo.platform_settings')
      .set({ document_retention_days: 0 })
      .execute();
    await files.purgeDue(job(), ignore);
    expect((await fileRow(tdb, file.id))?.purged_at).toBeInstanceOf(Date);
  });

  it('deletes only the blob its row names: other blobs and strays on the volume stay', async () => {
    const w = await filesWorld(tdb);
    const due = await uploaded(w);
    const other = await uploaded(w);
    await mkdir(join(dir.root, 'ff'), { recursive: true });
    await writeFile(
      join(dir.root, 'ff', 'ff000000000000000000000000000000'),
      'not a file of a row',
    );
    await files.delete(as(w.member), due.id, undefined, 1);
    await deletedDaysAgo('tribo.files', due.id, 40);
    const before = await dir.stored();
    await files.purgeDue(job(), ignore);
    const dueBlob = await blobOf(due.id);
    expect(await dir.stored()).toEqual(before.filter((key) => key !== dueBlob));
    expect(await dir.stored()).toContain(await blobOf(other.id));
    expect(await dir.stored()).toContain('ff/ff000000000000000000000000000000');
  });

  it('is safe to run again: a second run finds nothing and writes nothing', async () => {
    const w = await filesWorld(tdb);
    const file = await uploaded(w);
    await files.delete(as(w.member), file.id, undefined, 1);
    await deletedDaysAgo('tribo.files', file.id, 30);
    expect(await files.purgeDue(job(), ignore)).toMatchObject({ purged: 1 });
    const { events } = await history(tdb, file.id);
    expect(await files.purgeDue(job(), ignore)).toEqual({ due: 0, purged: 0, failed: 0 });
    expect((await history(tdb, file.id)).events).toEqual(events);
  });

  it('keeps a file whose blob cannot be deleted as it was, reports it, and purges the others', async () => {
    const w = await filesWorld(tdb);
    const stuck = await uploaded(w);
    const fine = await uploaded(w);
    for (const f of [stuck, fine]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      await files.delete(as(w.member), f.id, undefined, 1);
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      await deletedDaysAgo('tribo.files', f.id, 30);
    }
    const stuckBlob = await blobOf(stuck.id);
    const failing = filesService(tdb.db, {
      ...dir.blobs,
      delete: (key) =>
        key === stuckBlob
          ? Promise.reject(new Error('EROFS: read-only volume'))
          : dir.blobs.delete(key),
    });
    const failures: [string, unknown][] = [];
    expect(
      await failing.purgeDue(job(), (fileId, error) => failures.push([fileId, error])),
    ).toEqual({
      due: 2,
      purged: 1,
      failed: 1,
    });
    expect(failures).toEqual([[stuck.id, new Error('EROFS: read-only volume')]]);
    expect(await fileRow(tdb, stuck.id)).toMatchObject({ purged_at: null, version: 2 });
    expect((await history(tdb, stuck.id)).events.at(-1)?.action).toBe('delete');
    expect(await dir.stored()).toContain(stuckBlob);
    // The next run completes it.
    expect(await files.purgeDue(job(), ignore)).toMatchObject({ purged: 1 });
    expect(await dir.stored()).not.toContain(stuckBlob);
  });

  it('finds nothing due on a long-deleted trip that has no files', async () => {
    const owner = await filesWorld(tdb);
    const empty = await createTrip(tdb.db, { owner: owner.owner });
    await deletedDaysAgo('tribo.trips', empty.tripId, 90);
    expect(await files.purgeDue(job(), ignore)).toEqual({ due: 0, purged: 0, failed: 0 });
  });
});
