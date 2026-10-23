// @module-tag drop-b
// files.upload (Drop B): Multipart upload ≤ 25 MB; kind, visibility, itemId; file_too_large, file_type_not_allowed; id/ticket/voucher sensitive; trip_archived on archived trips (R29); Owner = callers membership (rule 3)
// Through the documents service and its blob store on a temporary volume: what is stored,
// who may store it, and that a refused or failed upload leaves neither a row nor a blob.
// The multipart parsing and Idempotency-Key replay are proven over HTTP in apps/server.
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { FilesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createItem, createTrip, createUser, softDelete, type UserFixture } from './factories.js';
import {
  blobDir,
  fileCount,
  fileRow,
  filesService,
  filesWorld,
  itemRef,
  part,
  sample,
  sha256,
  type BlobDir,
} from './files-world.js';

let tdb: TestDatabase;
let dir: BlobDir;
let files: FilesService;
const as = contexts('files-upload');

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});

/** Uploads as the owner while the trip is archived under it; expects the named failure. */
async function archiveWhileUploading(w: Awaited<ReturnType<typeof filesWorld>>, via: FilesService) {
  const data = sample('pdf', 20_000);
  let sent = false;
  const content = new Readable({
    read() {
      if (sent) return;
      sent = true;
      archive(tdb, w.tripId).then(
        () => {
          this.push(data);
          this.push(null);
        },
        (error: unknown) => this.destroy(error as Error),
      );
    },
  });
  const error: unknown = await via
    .upload(as(w.owner), w.tripId, { kind: 'other' }, part(data, { content }))
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    /^file [0-9a-f-]{36} did not commit \(trip_archived\) and its blob [0-9a-f]{2}\/[0-9a-f]{32} is left$/,
  );
  expect((error as Error).cause).toEqual(new Error('EROFS: read-only volume'));
}

/** The upload left nothing: no row in the trip, no blob on the volume beyond `before`. */
async function nothingStored(tripId: string, before: string[]) {
  expect(await fileCount(tdb, tripId)).toBe(0);
  expect(await dir.stored()).toEqual(before);
}

describe('files.upload', () => {
  it('stores the bytes encrypted under a server key, owned by the caller’s membership', async () => {
    const w = await filesWorld(tdb);
    const data = sample('pdf', 100_000);
    const file = await files.upload(
      as(w.member),
      w.tripId,
      { kind: 'ticket', itemId: undefined },
      part(data, { filename: 'Ferry to Batan.pdf', contentType: 'application/pdf' }),
    );
    expect(file).toEqual({
      id: expect.any(String) as string,
      tripId: w.tripId,
      itemId: null,
      ownerMembershipId: w.member.membershipId,
      kind: 'ticket',
      sensitive: true,
      visibility: 'shared',
      filename: 'Ferry to Batan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100_000,
      sha256: sha256(data),
      version: 1,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
      purgedAt: null,
    });
    const row = await fileRow(tdb, file.id);
    expect(row).toMatchObject({
      owner_membership_id: w.member.membershipId,
      created_by: w.member.userId,
      size_bytes: '100000',
      enc_key_version: 1,
    });
    // The blob key is the store's random name, never the client's file name.
    expect(row?.blob_key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{32}$/);
    expect(await dir.stored()).toContain(row?.blob_key);
    expect((await buffer(dir.blobs.read(file.id, row?.blob_key ?? ''))).equals(data)).toBe(true);
  });

  it('flags id, ticket and voucher sensitive, and photo and other not', async () => {
    const w = await filesWorld(tdb);
    const kinds = ['id', 'ticket', 'voucher', 'photo', 'other'] as const;
    const flags = [];
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop -- one upload at a time keeps the assertions in order
      const file = await files.upload(as(w.owner), w.tripId, { kind }, part(sample('png')));
      flags.push(file.sensitive);
    }
    expect(flags).toEqual([true, true, true, false, false]);
  });

  it('types the file from its bytes, whatever the client called it', async () => {
    const w = await filesWorld(tdb);
    const file = await files.upload(
      as(w.owner),
      w.tripId,
      { kind: 'photo', visibility: 'private' },
      part(sample('jpeg'), { filename: '../../uploads/beach', contentType: '' }),
    );
    expect(file).toMatchObject({
      mimeType: 'image/jpeg',
      filename: 'beach',
      visibility: 'private',
    });
  });

  it('lets owner, organizer and member upload; refuses a viewer with forbidden, storing nothing', async () => {
    const w = await filesWorld(tdb);
    for (const who of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- one upload at a time
      await files.upload(as(who), w.tripId, { kind: 'other' }, part(sample('pdf')));
    }
    expect(await fileCount(tdb, w.tripId)).toBe(3);
    const before = await dir.stored();
    expect(
      await refusal(files.upload(as(w.viewer), w.tripId, { kind: 'other' }, part(sample('pdf')))),
    ).toBe('forbidden');
    expect(await fileCount(tdb, w.tripId)).toBe(3);
    expect(await dir.stored()).toEqual(before);
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const upload = (who: UserFixture) =>
      refusal(files.upload(as(who), w.tripId, { kind: 'other' }, part(sample('pdf'))));
    expect(await upload(w.outsider)).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await upload(w.member)).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await upload(w.owner)).toBe('not_found');
    await nothingStored(w.tripId, before);
  });

  it('attaches to an item the caller sees in the trip, and refuses any other item alike', async () => {
    const w = await filesWorld(tdb);
    const file = await files.upload(
      as(w.member),
      w.tripId,
      { kind: 'voucher', itemId: itemRef(w.lodging) },
      part(sample('pdf')),
    );
    expect(file.itemId).toBe(w.lodging);

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
    const before = await dir.stored();
    // A hidden item, one in another trip, a deleted one and one that never existed answer
    // the same, so the refusal tells nothing about which exist.
    const answers = [];
    for (const itemId of [w.hidden, foreign, gone, '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d']) {
      // eslint-disable-next-line no-await-in-loop -- one upload at a time
      const error: unknown = await files
        .upload(
          as(w.member),
          w.tripId,
          { kind: 'other', itemId: itemRef(itemId) },
          part(sample('pdf')),
        )
        .catch((e: unknown) => e);
      answers.push(JSON.stringify(error));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? '{}')).toMatchObject({ code: 'validation_failed' });
    expect(await fileCount(tdb, w.tripId)).toBe(1);
    expect(await dir.stored()).toEqual(before);
  });

  it('refuses an invalid form with validation_failed before reading a byte', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    let read = false;
    const content = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    for (const form of [
      {},
      { kind: 'passport' },
      { kind: 'other', visibility: 'selected' },
      { kind: 'other', extra: 1 },
    ]) {
      const upload = files.upload(as(w.owner), w.tripId, form, part(Buffer.alloc(0), { content }));
      // eslint-disable-next-line no-await-in-loop -- one upload at a time
      expect(await refusal(upload)).toBe('validation_failed');
    }
    expect(read).toBe(false);
    await nothingStored(w.tripId, before);
  });

  it('answers file_type_not_allowed for bytes off the allowlist or a type they contradict', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const cases = [
      part(Buffer.from('<!doctype html><script>alert(1)</script>'), { filename: 'ticket.pdf' }),
      part(Buffer.from('GIF89a........'), { filename: 'map.gif', contentType: 'image/gif' }),
      part(Buffer.alloc(0), { filename: 'empty.pdf' }),
      part(sample('png'), { filename: 'scan.png', contentType: 'application/pdf' }),
      part(sample('pdf'), { filename: 'voucher.html', contentType: 'application/pdf' }),
    ];
    for (const p of cases) {
      // eslint-disable-next-line no-await-in-loop -- one upload at a time
      expect(await refusal(files.upload(as(w.owner), w.tripId, { kind: 'voucher' }, p))).toBe(
        'file_type_not_allowed',
      );
    }
    await nothingStored(w.tripId, before);
  });

  it('answers file_too_large past the ceiling, leaving nothing behind', async () => {
    const w = await filesWorld(tdb);
    const small = await blobDir({ maxBytes: 10_000 });
    try {
      const capped = filesService(tdb.db, small.blobs);
      await capped.upload(as(w.owner), w.tripId, { kind: 'photo' }, part(sample('png', 10_000)));
      const before = await small.stored();
      expect(
        await refusal(
          capped.upload(as(w.owner), w.tripId, { kind: 'photo' }, part(sample('png', 10_001))),
        ),
      ).toBe('file_too_large');
      expect(await fileCount(tdb, w.tripId)).toBe(1);
      expect(await small.stored()).toEqual(before);
    } finally {
      await small.remove();
    }
  });

  it('answers trip_archived on an archived trip before storing a byte', async () => {
    const w = await filesWorld(tdb);
    await archive(tdb, w.tripId);
    const before = await dir.stored();
    expect(
      await refusal(files.upload(as(w.owner), w.tripId, { kind: 'other' }, part(sample('pdf')))),
    ).toBe('trip_archived');
    await nothingStored(w.tripId, before);
  });

  it('removes the stored blob when the write refuses after it (archived while uploading)', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const data = sample('pdf', 50_000);
    let sent = false;
    // The trip is archived while the bytes are still arriving: the check before the stream
    // passed, the write path's trip guard does not.
    const content = new Readable({
      read() {
        if (sent) return;
        sent = true;
        archive(tdb, w.tripId).then(
          () => {
            this.push(data);
            this.push(null);
          },
          (error: unknown) => this.destroy(error as Error),
        );
      },
    });
    expect(
      await refusal(
        files.upload(as(w.owner), w.tripId, { kind: 'other' }, part(data, { content })),
      ),
    ).toBe('trip_archived');
    await nothingStored(w.tripId, before);
  });

  it('answers not_found and removes the blob when the caller leaves the trip while uploading', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const data = sample('pdf', 20_000);
    let sent = false;
    const content = new Readable({
      read() {
        if (sent) return;
        sent = true;
        softDelete(tdb.db, 'tribo.memberships', w.member.membershipId).then(
          () => {
            this.push(data);
            this.push(null);
          },
          (error: unknown) => this.destroy(error as Error),
        );
      },
    });
    expect(
      await refusal(
        files.upload(as(w.member), w.tripId, { kind: 'other' }, part(data, { content })),
      ),
    ).toBe('not_found');
    await nothingStored(w.tripId, before);
  });

  it('fails naming the file and blob left behind when its blob cannot be removed either', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const stuck = filesService(tdb.db, {
      ...dir.blobs,
      delete: () => Promise.reject(new Error('EROFS: read-only volume')),
    });
    const error: unknown = await stuck
      .upload(as(w.viewer), w.tripId, { kind: 'other' }, part(sample('pdf')))
      .catch((e: unknown) => e);
    // A viewer is refused before a byte is stored, so nothing needed removing.
    expect(error).toMatchObject({ code: 'forbidden' });
    await archiveWhileUploading(w, stuck);
    const left = (await dir.stored()).filter((key) => !before.includes(key));
    expect(left).toHaveLength(1);
    await dir.blobs.delete(left[0] ?? '');
  });

  it('leaves nothing when the client’s stream fails part way', async () => {
    const w = await filesWorld(tdb);
    const before = await dir.stored();
    const content = new Readable({
      read() {
        this.push(sample('pdf', 70_000));
        this.destroy(new Error('client went away'));
      },
    });
    await expect(
      files.upload(as(w.owner), w.tripId, { kind: 'other' }, part(Buffer.alloc(0), { content })),
    ).rejects.toThrow('client went away');
    await nothingStored(w.tripId, before);
  });

  it('records the create event and a snapshot without the blob key, in the one transaction', async () => {
    const w = await filesWorld(tdb);
    const data = sample('png');
    const ctx = as(w.member);
    const file = await files.upload(
      ctx,
      w.tripId,
      { kind: 'photo', itemId: itemRef(w.lodging) },
      part(data, { filename: 'room.png' }),
    );
    expect(await history(tdb, file.id)).toEqual({
      events: [
        {
          chain_key: `trip:${w.tripId}`,
          action: 'create',
          entity_type: 'file',
          version_before: null,
          version_after: 1,
          request_id: ctx.requestId,
        },
      ],
      snapshots: [
        {
          entity_type: 'file',
          version: 1,
          snapshot: {
            tripId: w.tripId,
            itemId: w.lodging,
            ownerMembershipId: w.member.membershipId,
            kind: 'photo',
            visibility: 'shared',
            filename: 'room.png',
            mimeType: 'image/png',
            sizeBytes: data.length,
            sha256: sha256(data),
          },
        },
      ],
    });
  });

  it('records no event and no snapshot for a refused upload', async () => {
    const w = await filesWorld(tdb);
    const outsider = await createUser(tdb.db);
    await refusal(files.upload(as(outsider), w.tripId, { kind: 'other' }, part(sample('pdf'))));
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select('id')
      .where('trip_id', '=', w.tripId)
      .where('entity_type', '=', 'file')
      .execute();
    expect(events).toEqual([]);
  });
});
