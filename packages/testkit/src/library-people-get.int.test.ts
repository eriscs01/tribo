// @module-tag drop-a
// library.people.get (Drop A): Person detail; person_visible; emergency contact masked; Merged id resolves to the survivor
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createPlaceholder, createTrip, createUser, softDelete } from './factories.js';

let tdb: TestDatabase;
let library: LibraryService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  library = createLibraryService(tdb.db, writePath(tdb.db), keyring(new AppKey(randomBytes(32))));
});
afterAll(() => tdb.destroy());

async function notFound(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('not_found');
}

/** An owner's trip with a member and a placeholder in it, plus an outsider. */
async function world() {
  const owner = await createUser(tdb.db);
  const member = await createUser(tdb.db);
  const outsider = await createUser(tdb.db);
  const placeholder = await createPlaceholder(tdb.db, { createdBy: owner.userId });
  const { tripId } = await createTrip(tdb.db, { owner });
  const memberMembership = await addMember(tdb.db, {
    tripId,
    personId: member.personId,
    role: 'viewer',
  });
  const placeholderMembership = await addMember(tdb.db, {
    tripId,
    personId: placeholder,
    role: 'member',
  });
  return { owner, member, outsider, placeholder, tripId, memberMembership, placeholderMembership };
}

describe('library.people.get', () => {
  it('shows a person to themself, a placeholder to its creator, and co-members to each other', async () => {
    const w = await world();
    await expect(library.getPerson(w.member.userId, w.member.personId)).resolves.toMatchObject({
      id: w.member.personId,
      hasAccount: true,
    });
    const lone = await createPlaceholder(tdb.db, { createdBy: w.outsider.userId });
    await expect(library.getPerson(w.outsider.userId, lone)).resolves.toMatchObject({
      id: lone,
      hasAccount: false,
    });
    // Co-members, whatever their trip role.
    await expect(library.getPerson(w.member.userId, w.owner.personId)).resolves.toMatchObject({
      id: w.owner.personId,
    });
    await expect(library.getPerson(w.member.userId, w.placeholder)).resolves.toMatchObject({
      id: w.placeholder,
    });
  });

  it('answers not_found to an account that shares no trip with the person', async () => {
    const w = await world();
    await notFound(library.getPerson(w.outsider.userId, w.member.personId));
    await notFound(library.getPerson(w.outsider.userId, w.placeholder));
    await notFound(library.getPerson(w.member.userId, '01900000-0000-7000-8000-000000000000'));
  });

  it('stops showing co-members once a membership is removed or the trip deleted', async () => {
    const removed = await world();
    await softDelete(tdb.db, 'tribo.memberships', removed.memberMembership);
    await notFound(library.getPerson(removed.member.userId, removed.owner.personId));

    const deleted = await world();
    await softDelete(tdb.db, 'tribo.trips', deleted.tripId);
    await notFound(library.getPerson(deleted.member.userId, deleted.placeholder));
    // The creator clause does not depend on a trip.
    await expect(
      library.getPerson(deleted.owner.userId, deleted.placeholder),
    ).resolves.toMatchObject({ id: deleted.placeholder });
  });

  it('resolves a merged placeholder id to its survivor, when the survivor is visible', async () => {
    const w = await world();
    // As a claim leaves it: the placeholder's membership moved, the row scrubbed and merged.
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ deleted_at: new Date() })
      .where('id', '=', w.placeholderMembership)
      .execute();
    await tdb.db
      .updateTable('tribo.persons')
      .set({ merged_into: w.member.personId, deleted_at: new Date() })
      .where('id', '=', w.placeholder)
      .execute();
    await expect(library.getPerson(w.owner.userId, w.placeholder)).resolves.toMatchObject({
      id: w.member.personId,
      hasAccount: true,
    });
    await notFound(library.getPerson(w.outsider.userId, w.placeholder));
  });

  it('masks the emergency contact even for the person themself', async () => {
    const ana = await createUser(tdb.db);
    const created = await library.createPerson(
      { requestId: 'req-mask', surface: 'web', userId: ana.userId },
      { displayName: 'Carla Cruz', emergencyContact: { name: 'Rosa Cruz', phone: '+63 917 555' } },
    );
    const read = await library.getPerson(ana.userId, created.id);
    expect(read.hasEmergencyContact).toBe(true);
    expect(JSON.stringify(read)).not.toContain('Rosa');
  });
});
