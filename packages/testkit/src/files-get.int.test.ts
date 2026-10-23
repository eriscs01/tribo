// @module-tag drop-b
// files.get (Drop B): File metadata; As files.list; purged shows purgedAt
// Through the documents service: one file's metadata to whoever files.list shows it to, and
// one answer, from the same queries, for every file they may not see.
import type { FilesService } from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createFile, createTrip, createUser, softDelete } from './factories.js';
import { blobDir, filesService, filesWorld, type BlobDir } from './files-world.js';

let tdb: TestDatabase;
let dir: BlobDir;
let files: FilesService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  dir = await blobDir();
  files = filesService(tdb.db, dir.blobs);
});
afterAll(async () => {
  await dir.remove();
  await tdb.destroy();
});

/** A handle that counts the statements run through it. */
function counted(db: Kysely<DB>) {
  const state = { queries: 0 };
  const handle = db.withPlugin({
    transformQuery(args) {
      state.queries += 1;
      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  });
  return { handle, state };
}

describe('files.get', () => {
  it('answers the file’s metadata to every role that lists it', async () => {
    const w = await filesWorld(tdb);
    const fileId = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      itemId: w.lodging,
      kind: 'voucher',
      filename: 'Guest house voucher.pdf',
    });
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await files.get(who.userId, fileId)).toMatchObject({
        id: fileId,
        itemId: w.lodging,
        kind: 'voucher',
        sensitive: true,
        filename: 'Guest house voucher.pdf',
        purgedAt: null,
      });
    }
  });

  it('shows purgedAt and the name purged for a purged file', async () => {
    const w = await filesWorld(tdb);
    const fileId = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      kind: 'id',
      purged: true,
    });
    const file = await files.get(w.member.userId, fileId);
    expect(file.filename).toBe('purged');
    expect(file.purgedAt).toBeInstanceOf(Date);
  });

  it('answers not_found alike for a file that is hidden, deleted, elsewhere or unknown', async () => {
    const w = await filesWorld(tdb);
    const own = (init: Partial<Parameters<typeof createFile>[1]>) =>
      createFile(tdb.db, { tripId: w.tripId, ownerMembershipId: w.other.membershipId, ...init });
    const privateFile = await own({ visibility: 'private' });
    const onHidden = await own({ itemId: w.hidden });
    const deleted = await own({ deleted: true });
    const elsewhere = await createTrip(tdb.db, { owner: await createUser(tdb.db) });
    const foreign = await createFile(tdb.db, {
      tripId: elsewhere.tripId,
      ownerMembershipId: elsewhere.ownerMembershipId,
    });
    const unknown = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d';
    for (const fileId of [privateFile, onHidden, deleted, foreign, unknown]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await refusal(files.get(w.member.userId, fileId))).toBe('not_found');
    }
    // Its owner still reads the private one and the one on their own private item.
    expect((await files.get(w.other.userId, privateFile)).id).toBe(privateFile);
    expect((await files.get(w.other.userId, onHidden)).id).toBe(onHidden);
  });

  it('answers not_found to a removed member and on a deleted trip', async () => {
    const w = await filesWorld(tdb);
    const fileId = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
    });
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(await refusal(files.get(w.member.userId, fileId))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(files.get(w.owner.userId, fileId))).toBe('not_found');
  });

  it('runs the same queries whether the file is visible, hidden, elsewhere or unknown', async () => {
    const w = await filesWorld(tdb);
    const visible = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
    });
    const hidden = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
    });
    const elsewhere = await createTrip(tdb.db, { owner: await createUser(tdb.db) });
    const foreign = await createFile(tdb.db, {
      tripId: elsewhere.tripId,
      ownerMembershipId: elsewhere.ownerMembershipId,
    });
    const counts = [];
    for (const fileId of [visible, hidden, foreign, '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d']) {
      const { handle, state } = counted(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      await filesService(handle, dir.blobs)
        .get(w.member.userId, fileId)
        .catch(() => undefined);
      counts.push(state.queries);
    }
    expect(new Set(counts).size).toBe(1);
  });
});
