// @module-tag drop-b
// files.delete (Drop B): Soft-delete file; Blob kept until purge; Blob purged document_retention_days after deletion; trip_archived on archived trips (R29)
// Through the documents service, with real uploads: the row is soft-deleted and versioned,
// the blob stays on the volume for the retention purge, and the file leaves every read.
import type { FileRecord, FilesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';
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
const as = contexts('files-delete');

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});

const memberFile = (w: Awaited<ReturnType<typeof filesWorld>>): Promise<FileRecord> =>
  files.upload(as(w.member), w.tripId, { kind: 'voucher' }, part(sample('pdf')));

describe('files.delete', () => {
  it('soft-deletes the row and keeps the blob for the purge', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    const blobKey = (await fileRow(tdb, file.id))?.blob_key ?? '';
    await files.delete(as(w.member), file.id, undefined, 1);
    expect(await fileRow(tdb, file.id)).toMatchObject({
      version: 2,
      deleted_at: expect.any(Date) as Date,
      purged_at: null,
      blob_key: blobKey,
    });
    expect(await dir.stored()).toContain(blobKey);
    expect(await refusal(files.get(w.member.userId, file.id))).toBe('not_found');
    expect((await files.list(w.owner.userId, w.tripId, { limit: 50 })).items).toEqual([]);
  });

  it('lets the file’s owner, organizers and the trip owner delete; refuses other members and viewers', async () => {
    const w = await filesWorld(tdb);
    for (const who of [w.member, w.organizer, w.owner]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      const file = await memberFile(w);
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      await expect(files.delete(as(who), file.id, undefined, 1)).resolves.toBeUndefined();
    }
    const file = await memberFile(w);
    expect(await refusal(files.delete(as(w.other), file.id, undefined, 1))).toBe('forbidden');
    expect(await refusal(files.delete(as(w.viewer), file.id, undefined, 1))).toBe('forbidden');
    expect((await fileRow(tdb, file.id))?.deleted_at).toBeNull();
  });

  it('answers not_found for a hidden file, outside the trip and for a file already deleted', async () => {
    const w = await filesWorld(tdb);
    const secret = await files.upload(
      as(w.other),
      w.tripId,
      { kind: 'id', visibility: 'private' },
      part(sample('jpeg')),
    );
    expect(await refusal(files.delete(as(w.owner), secret.id, undefined, 1))).toBe('not_found');
    const stranger = await createUser(tdb.db);
    expect(await refusal(files.delete(as(stranger), secret.id, undefined, 1))).toBe('not_found');
    await files.delete(as(w.other), secret.id, undefined, 1);
    expect(await refusal(files.delete(as(w.other), secret.id, undefined, 2))).toBe('not_found');
  });

  it('refuses a body with validation_failed and takes If-Match = version', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    expect(await refusal(files.delete(as(w.member), file.id, { reason: 'x' }, 1))).toBe(
      'validation_failed',
    );
    expect(await refusal(files.delete(as(w.member), file.id, undefined, undefined))).toBe(
      'if_match_required',
    );
    expect(await refusal(files.delete(as(w.member), file.id, undefined, 3))).toBe(
      'version_conflict',
    );
    expect((await fileRow(tdb, file.id))?.deleted_at).toBeNull();
  });

  it('answers trip_archived on an archived trip', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    await archive(tdb, w.tripId);
    expect(await refusal(files.delete(as(w.member), file.id, undefined, 1))).toBe('trip_archived');
  });

  it('records the delete and a snapshot of the file as it was, in the one transaction', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    const ctx = as(w.member);
    await files.delete(ctx, file.id, undefined, 1);
    const { events, snapshots } = await history(tdb, file.id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'delete',
      entity_type: 'file',
      version_before: 1,
      version_after: 2,
      request_id: ctx.requestId,
    });
    expect(snapshots.at(-1)).toMatchObject({ version: 2, snapshot: { kind: 'voucher' } });
  });
});
