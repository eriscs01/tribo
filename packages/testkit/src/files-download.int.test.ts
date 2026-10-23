// @module-tag drop-b
// files.download (Drop B): Stream decrypted bytes; Permission re-checked each request; no-store; file_purged
// Through the documents service and a real blob store: the bytes as uploaded, to whoever
// may see the file at the moment they ask; a damaged blob fails rather than yields garbage;
// a sensitive file's download is audited as a reveal. Headers are proven over HTTP.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { FileRecord, FilesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contexts, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createFile, createUser, softDelete, type UserFixture } from './factories.js';
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
const as = contexts('files-download');

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});

type World = Awaited<ReturnType<typeof filesWorld>>;

async function upload(w: World, kind: 'photo' | 'id' = 'photo', size = 4_096) {
  const data = sample('png', size);
  const file = await files.upload(as(w.member), w.tripId, { kind }, part(data));
  return { data, file };
}

async function bytesOf(who: UserFixture, file: FileRecord): Promise<Buffer> {
  const { content } = await files.download(as(who), file.id);
  return buffer(content);
}

const reveals = (fileId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select(['action', 'entity_type', 'trip_id', 'reason', 'request_id', 'actor_user_id'])
    .where('entity_id', '=', fileId)
    .where('action', '=', 'reveal')
    .execute();

describe('files.download', () => {
  it('streams the bytes as uploaded to every role that sees the file', async () => {
    const w = await filesWorld(tdb);
    const { data, file } = await upload(w, 'photo', 200_000);
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const { file: meta, content } = await files.download(as(who), file.id);
      expect(meta).toMatchObject({ id: file.id, mimeType: 'image/png', sizeBytes: 200_000 });
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect((await buffer(content)).equals(data)).toBe(true);
    }
  });

  it('checks permission on every request: a change since the last one is honoured at once', async () => {
    const w = await filesWorld(tdb);
    const { data, file } = await upload(w);
    expect((await bytesOf(w.other, file)).equals(data)).toBe(true);
    // Made private by its owner: the other member's next download finds nothing.
    await files.update(as(w.member), file.id, { visibility: 'private' }, 1);
    expect(await refusal(files.download(as(w.other), file.id))).toBe('not_found');
    // Back to shared, but on an item the other member cannot see.
    const mine = await files.update(
      as(w.member),
      file.id,
      { visibility: 'shared', itemId: itemRef(w.lodging) },
      2,
    );
    expect(mine.itemId).toBe(w.lodging);
    expect((await bytesOf(w.other, file)).equals(data)).toBe(true);
    await tdb.db
      .updateTable('tribo.items')
      .set({ visibility: 'private' })
      .where('id', '=', w.lodging)
      .execute();
    expect(await refusal(files.download(as(w.other), file.id))).toBe('not_found');
    // Removed from the trip: not even their own file.
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await refusal(files.download(as(w.member), file.id))).toBe('not_found');
  });

  it('answers not_found for a hidden, deleted, foreign or unknown file and on a deleted trip', async () => {
    const w = await filesWorld(tdb);
    const secret = await files.upload(
      as(w.other),
      w.tripId,
      { kind: 'photo', visibility: 'private' },
      part(sample('png')),
    );
    expect(await refusal(files.download(as(w.owner), secret.id))).toBe('not_found');
    const stranger = await createUser(tdb.db);
    expect(await refusal(files.download(as(stranger), secret.id))).toBe('not_found');
    expect(await refusal(files.download(as(w.owner), '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d'))).toBe(
      'not_found',
    );
    const { file } = await upload(w);
    await files.delete(as(w.member), file.id, undefined, 1);
    expect(await refusal(files.download(as(w.member), file.id))).toBe('not_found');
    const { file: kept } = await upload(w);
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(files.download(as(w.member), kept.id))).toBe('not_found');
  });

  it('answers file_purged for a purged file the caller can see', async () => {
    const w = await filesWorld(tdb);
    const fileId = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      kind: 'ticket',
      purged: true,
    });
    expect(await refusal(files.download(as(w.viewer), fileId))).toBe('file_purged');
    expect(await reveals(fileId)).toEqual([]);
  });

  it('records a reveal of a sensitive file’s content before sending it, and nothing for others', async () => {
    const w = await filesWorld(tdb);
    const { file: id } = await upload(w, 'id');
    const { file: photo } = await upload(w);
    const ctx = as(w.viewer);
    await buffer((await files.download(ctx, id.id)).content);
    await buffer((await files.download(as(w.viewer), photo.id)).content);
    expect(await reveals(id.id)).toEqual([
      {
        action: 'reveal',
        entity_type: 'file',
        trip_id: w.tripId,
        reason: 'content',
        request_id: ctx.requestId,
        actor_user_id: w.viewer.userId,
      },
    ]);
    expect(await reveals(photo.id)).toEqual([]);
    // A refused download of it records nothing.
    expect(await refusal(files.download(as(await createUser(tdb.db)), id.id))).toBe('not_found');
    expect(await reveals(id.id)).toHaveLength(1);
  });

  it('fails the stream, never yields altered bytes, when the blob was tampered with', async () => {
    const w = await filesWorld(tdb);
    const { file } = await upload(w, 'photo', 150_000);
    const path = join(dir.root, (await fileRow(tdb, file.id))?.blob_key ?? '');
    const blob = await readFile(path);
    blob[blob.length - 20] = 255 - (blob[blob.length - 20] ?? 0);
    await writeFile(path, blob);
    const { content } = await files.download(as(w.member), file.id);
    await expect(buffer(content)).rejects.toThrow(/file/);
  });
});
