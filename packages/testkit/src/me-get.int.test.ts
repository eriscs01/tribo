// @module-tag drop-a
// me.get (Drop A): Caller account + own person profile; Own sensitive fields masked; reveal via library.people.reveal
// The account half comes from the session; the HTTP shape is proven in apps/server/src/library.int.test.ts.
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser, softDelete } from './factories.js';

let tdb: TestDatabase;
let library: LibraryService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  library = createLibraryService(tdb.db, writePath(tdb.db), keyring(new AppKey(randomBytes(32))));
});
afterAll(() => tdb.destroy());

describe('me.get', () => {
  it('enforces the roles column: self — each account reads only its own person', async () => {
    const ana = await createUser(tdb.db, { displayName: 'Ana Reyes' });
    const ben = await createUser(tdb.db, { displayName: 'Ben Santos' });
    await expect(library.ownPerson(ana.userId)).resolves.toMatchObject({
      id: ana.personId,
      displayName: 'Ana Reyes',
      hasAccount: true,
    });
    await expect(library.ownPerson(ben.userId)).resolves.toMatchObject({ id: ben.personId });
  });

  it('masks the own emergency contact; the plaintext needs library.people.reveal', async () => {
    const ana = await createUser(tdb.db);
    // Any stored ciphertext will do: the read never opens it.
    const ciphertext = randomBytes(48);
    await tdb.db
      .updateTable('tribo.persons')
      .set({ emergency_contact_enc: ciphertext })
      .where('id', '=', ana.personId)
      .execute();
    const me = await library.ownPerson(ana.userId);
    expect(me.hasEmergencyContact).toBe(true);
    expect(Object.values(me)).not.toContainEqual(ciphertext);
  });

  it('answers not_found to an account whose person is gone', async () => {
    const ana = await createUser(tdb.db);
    await softDelete(tdb.db, 'tribo.persons', ana.personId);
    const error: unknown = await library.ownPerson(ana.userId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('not_found');
  });
});
