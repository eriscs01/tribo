// @module-tag drop-b
// files.update (Drop B): Rename, relink item, change visibility; trip_archived on archived trips (R29)
// Through the documents service, with real uploads: who may change a file's metadata, what
// a change may be, and that each one is versioned and recorded.
import type { FileRecord, FilesService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createItem, createTrip, createUser, softDelete } from './factories.js';
import {
  blobDir,
  fileRow,
  filesService,
  filesWorld,
  itemRef,
  part,
  sample,
  type BlobDir,
} from './files-world.js';

let tdb: TestDatabase;
let dir: BlobDir;
let files: FilesService;
const as = contexts('files-update');

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});

/** A shared PDF the member uploaded, on no item. */
async function memberFile(w: Awaited<ReturnType<typeof filesWorld>>): Promise<FileRecord> {
  return files.upload(
    as(w.member),
    w.tripId,
    { kind: 'ticket' },
    part(sample('pdf'), { filename: 'Ferry.pdf' }),
  );
}

describe('files.update', () => {
  it('renames, relinks and changes visibility under If-Match, bumping the version', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    const renamed = await files.update(
      as(w.member),
      file.id,
      { filename: '../Ferry to Batan.PDF', itemId: itemRef(w.lodging) },
      1,
    );
    expect(renamed).toMatchObject({
      filename: 'Ferry to Batan.PDF',
      itemId: w.lodging,
      visibility: 'shared',
      version: 2,
    });
    const detached = await files.update(
      as(w.member),
      file.id,
      { itemId: null, visibility: 'private' },
      2,
    );
    expect(detached).toMatchObject({ itemId: null, visibility: 'private', version: 3 });
    expect(detached.updatedAt.getTime()).toBeGreaterThanOrEqual(file.updatedAt.getTime());
  });

  it('lets the file’s owner, organizers and the trip owner change it; refuses other members and viewers', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    await files.update(as(w.organizer), file.id, { filename: 'a.pdf' }, 1);
    await files.update(as(w.owner), file.id, { filename: 'b.pdf' }, 2);
    expect(await refusal(files.update(as(w.other), file.id, { filename: 'c.pdf' }, 3))).toBe(
      'forbidden',
    );
    expect(await refusal(files.update(as(w.viewer), file.id, { filename: 'c.pdf' }, 3))).toBe(
      'forbidden',
    );
    expect((await fileRow(tdb, file.id))?.filename).toBe('b.pdf');
  });

  it('answers not_found for a file the caller cannot see, outside the trip and once deleted', async () => {
    const w = await filesWorld(tdb);
    const secret = await files.upload(
      as(w.other),
      w.tripId,
      { kind: 'photo', visibility: 'private' },
      part(sample('png')),
    );
    expect(await refusal(files.update(as(w.owner), secret.id, { filename: 'x.png' }, 1))).toBe(
      'not_found',
    );
    const stranger = await createUser(tdb.db);
    expect(await refusal(files.update(as(stranger), secret.id, { filename: 'x.png' }, 1))).toBe(
      'not_found',
    );
    await softDelete(tdb.db, 'tribo.files', secret.id);
    expect(await refusal(files.update(as(w.other), secret.id, { filename: 'x.png' }, 1))).toBe(
      'not_found',
    );
  });

  it('keeps an extension of the file’s type, and refuses another with file_type_not_allowed', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    expect(await refusal(files.update(as(w.member), file.id, { filename: 'ticket.html' }, 1))).toBe(
      'file_type_not_allowed',
    );
    expect((await files.update(as(w.member), file.id, { filename: 'ticket' }, 1)).filename).toBe(
      'ticket',
    );
  });

  it('refuses an item the caller cannot see, of another trip or deleted, alike', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    const elsewhere = await createTrip(tdb.db, { owner: w.member });
    const foreign = await createItem(tdb.db, {
      tripId: elsewhere.tripId,
      ownerMembershipId: elsewhere.ownerMembershipId,
    });
    const gone = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
    });
    await softDelete(tdb.db, 'tribo.items', gone);
    for (const itemId of [w.hidden, foreign, gone]) {
      const relink = files.update(as(w.member), file.id, { itemId: itemRef(itemId) }, 1);
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      expect(await refusal(relink)).toBe('validation_failed');
    }
    expect((await fileRow(tdb, file.id))?.item_id).toBeNull();
  });

  it('refuses an invalid patch with validation_failed', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    for (const patch of [
      { kind: 'id' },
      { visibility: 'selected' },
      { filename: '' },
      { sha256: 'x' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      expect(await refusal(files.update(as(w.member), file.id, patch, 1))).toBe(
        'validation_failed',
      );
    }
  });

  it('takes If-Match = version: none is if_match_required, a stale one version_conflict', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    expect(
      await refusal(files.update(as(w.member), file.id, { filename: 'a.pdf' }, undefined)),
    ).toBe('if_match_required');
    expect(await refusal(files.update(as(w.member), file.id, { filename: 'a.pdf' }, 7))).toBe(
      'version_conflict',
    );
    expect((await fileRow(tdb, file.id))?.version).toBe(1);
  });

  it('answers trip_archived on an archived trip and file_purged for a purged file', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    await tdb.db
      .updateTable('tribo.files')
      .set({ purged_at: new Date(), filename: 'purged' })
      .where('id', '=', file.id)
      .execute();
    expect(await refusal(files.update(as(w.member), file.id, { visibility: 'private' }, 1))).toBe(
      'file_purged',
    );
    const other = await memberFile(w);
    await archive(tdb, w.tripId);
    expect(await refusal(files.update(as(w.member), other.id, { filename: 'a.pdf' }, 1))).toBe(
      'trip_archived',
    );
  });

  it('records the update and the new snapshot in the one transaction', async () => {
    const w = await filesWorld(tdb);
    const file = await memberFile(w);
    const ctx: RequestContext = as(w.member);
    await files.update(ctx, file.id, { filename: 'Ferry 2.pdf' }, 1);
    const { events, snapshots } = await history(tdb, file.id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'update',
      entity_type: 'file',
      version_before: 1,
      version_after: 2,
      request_id: ctx.requestId,
    });
    expect(snapshots.at(-1)).toMatchObject({ version: 2, snapshot: { filename: 'Ferry 2.pdf' } });
  });
});
