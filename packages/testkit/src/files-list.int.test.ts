// @module-tag drop-b
// files.list (Drop B): File metadata; File visibility AND item_visible(parent)
// Through the documents service: which files a member lists, in what order and pages. The
// property over random worlds is files-list.leak.test.ts.
import type { FilesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createFile, createItem, createUser, softDelete } from './factories.js';
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

const ids = async (userId: string, tripId: string, limit = 50) =>
  (await files.list(userId, tripId, { limit })).items.map((f) => f.id);

describe('files.list', () => {
  it('lists the trip’s files oldest first, with their metadata', async () => {
    const w = await filesWorld(tdb);
    const first = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      kind: 'ticket',
      filename: 'Ferry.pdf',
    });
    const second = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      itemId: w.lodging,
    });
    const page = await files.list(w.viewer.userId, w.tripId, { limit: 50 });
    expect(page.items.map((f) => f.id)).toEqual([first, second]);
    expect(page.items[0]).toMatchObject({
      tripId: w.tripId,
      itemId: null,
      ownerMembershipId: w.member.membershipId,
      kind: 'ticket',
      sensitive: true,
      visibility: 'shared',
      filename: 'Ferry.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1_234,
      version: 1,
      purgedAt: null,
    });
    expect(page.items[1]?.itemId).toBe(w.lodging);
    expect(page.nextCursor).toBeNull();
  });

  it('lets every role list, a viewer included', async () => {
    const w = await filesWorld(tdb);
    const file = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
    });
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await ids(who.userId, w.tripId)).toEqual([file]);
    }
  });

  it('shows a private file to its owner alone, organizers and the trip owner included', async () => {
    const w = await filesWorld(tdb);
    const mine = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      visibility: 'private',
    });
    expect(await ids(w.member.userId, w.tripId)).toEqual([mine]);
    for (const who of [w.owner, w.organizer, w.other, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect(await ids(who.userId, w.tripId)).toEqual([]);
    }
  });

  it('hides a shared file on an item the caller cannot see, and on a deleted item', async () => {
    const w = await filesWorld(tdb);
    const onHidden = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      itemId: w.hidden,
    });
    expect(await ids(w.other.userId, w.tripId)).toEqual([onHidden]);
    expect(await ids(w.owner.userId, w.tripId)).toEqual([]);
    const selected = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      visibility: 'selected',
      sharedWith: [w.member.membershipId],
    });
    const onSelected = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      itemId: selected,
    });
    expect(await ids(w.member.userId, w.tripId)).toEqual([onSelected]);
    expect(await ids(w.viewer.userId, w.tripId)).toEqual([]);
    await softDelete(tdb.db, 'tribo.items', selected);
    expect(await ids(w.owner.userId, w.tripId)).toEqual([]);
  });

  it('leaves out deleted files and keeps purged ones, with purgedAt', async () => {
    const w = await filesWorld(tdb);
    await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      deleted: true,
    });
    const purged = await createFile(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      kind: 'id',
      purged: true,
    });
    const page = await files.list(w.member.userId, w.tripId, { limit: 50 });
    expect(page.items.map((f) => [f.id, f.filename, f.purgedAt instanceof Date])).toEqual([
      [purged, 'purged', true],
    ]);
  });

  it('pages with a cursor', async () => {
    const w = await filesWorld(tdb);
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      const init = { tripId: w.tripId, ownerMembershipId: w.owner.membershipId };
      // eslint-disable-next-line no-await-in-loop -- in order, so ids ascend
      made.push(await createFile(tdb.db, init));
    }
    const one = await files.list(w.member.userId, w.tripId, { limit: 2 });
    expect(one.items.map((f) => f.id)).toEqual(made.slice(0, 2));
    const two = await files.list(w.member.userId, w.tripId, {
      limit: 2,
      cursor: one.nextCursor ?? '',
    });
    expect(two.items.map((f) => f.id)).toEqual(made.slice(2));
    expect(two.nextCursor).toBeNull();
    expect(await refusal(files.list(w.member.userId, w.tripId, { limit: 2, cursor: 'nope' }))).toBe(
      'validation_failed',
    );
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await filesWorld(tdb);
    await createFile(tdb.db, { tripId: w.tripId, ownerMembershipId: w.owner.membershipId });
    const stranger = await createUser(tdb.db);
    expect(await refusal(files.list(stranger.userId, w.tripId, { limit: 50 }))).toBe('not_found');
    const leaver = await createUser(tdb.db);
    const membership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: leaver.personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', membership);
    expect(await refusal(files.list(leaver.userId, w.tripId, { limit: 50 }))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(files.list(w.owner.userId, w.tripId, { limit: 50 }))).toBe('not_found');
  });
});
