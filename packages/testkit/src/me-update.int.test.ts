// @module-tag drop-a
// me.update (Drop A): Edit own profile (name, contacts, dietary, emergency contact, licence); masked_field_write on masked fields
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring, openJson, type Keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser, type UserFixture } from './factories.js';

let tdb: TestDatabase;
let keys: Keyring;
let library: LibraryService;
let n = 0;
const as = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `req-${String(n)}`, surface: 'web', userId: user.userId };
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  keys = keyring(new AppKey(randomBytes(32)));
  library = createLibraryService(tdb.db, writePath(tdb.db), keys);
});
afterAll(() => tdb.destroy());

async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

const stored = (personId: string) =>
  tdb.db
    .selectFrom('tribo.persons')
    .select(['version', 'display_name', 'dietary', 'emergency_contact_enc', 'updated_by'])
    .where('id', '=', personId)
    .executeTakeFirstOrThrow();

const events = (personId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select([
      'chain_key',
      'action',
      'entity_type',
      'actor_user_id',
      'version_before',
      'version_after',
    ])
    .where('entity_id', '=', personId)
    .orderBy('seq')
    .execute();

describe('me.update', () => {
  it('enforces the roles column: self — the caller edits only their own person', async () => {
    const ana = await createUser(tdb.db, { displayName: 'Ana Reyes' });
    const ben = await createUser(tdb.db, { displayName: 'Ben Santos' });
    const me = await library.updateOwnPerson(
      as(ana),
      {
        displayName: 'Ana R.',
        contacts: { phone: '+63 917 555 0104' },
        dietary: 'Vegetarian',
        drivingLicence: true,
      },
      1,
    );
    expect(me).toMatchObject({
      id: ana.personId,
      displayName: 'Ana R.',
      hasAccount: true,
      contacts: { phone: '+63 917 555 0104' },
      dietary: 'Vegetarian',
      drivingLicence: true,
      version: 2,
    });
    expect(await stored(ana.personId)).toMatchObject({ version: 2, updated_by: ana.userId });
    expect(await stored(ben.personId)).toMatchObject({ version: 1, display_name: 'Ben Santos' });
  });

  it('refuses an erased person, which stays a tombstone', async () => {
    const ana = await createUser(tdb.db);
    await tdb.db
      .updateTable('tribo.persons')
      .set({ erased_at: new Date(), display_name: 'Erased traveller' })
      .where('id', '=', ana.personId)
      .execute();
    expect(await refusal(library.updateOwnPerson(as(ana), { dietary: 'Vegan' }, 1))).toBe(
      'forbidden',
    );
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const ana = await createUser(tdb.db);
    const bodies = [
      { displayName: '' },
      { drivingLicence: 'yes' },
      { contacts: { email: 'not-an-email' } },
      { emergencyContact: { phone: '+63 917 555 0105' } },
      { username: 'someone_else' },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(library.updateOwnPerson(as(ana), body, 1));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect((await stored(ana.personId)).version).toBe(1);
    expect(await events(ana.personId)).toEqual([]);
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const ana = await createUser(tdb.db);
    const edit = (ifMatch: number | undefined) =>
      library.updateOwnPerson(as(ana), { dietary: 'Vegan' }, ifMatch);
    expect(await refusal(edit(undefined))).toBe('if_match_required');
    expect(await refusal(edit(7))).toBe('version_conflict');
    await expect(edit(1)).resolves.toMatchObject({ version: 2 });
    expect(await refusal(edit(1))).toBe('version_conflict');
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const ana = await createUser(tdb.db);
    await library.updateOwnPerson(as(ana), { dietary: 'Vegan' }, 1);
    expect(await events(ana.personId)).toEqual([
      {
        chain_key: 'platform',
        action: 'update',
        entity_type: 'person',
        actor_user_id: ana.userId,
        version_before: 1,
        version_after: 2,
      },
    ]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'trip_id', 'snapshot'])
      .where('entity_id', '=', ana.personId)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({
      entity_type: 'person',
      version: 2,
      trip_id: null,
      snapshot: { userId: ana.userId, dietary: 'Vegan' },
    });
  });

  it('stores the own emergency contact encrypted, and answers masked_field_write to its masked value', async () => {
    const ana = await createUser(tdb.db);
    const contact = { name: 'Rosa Reyes', relation: 'sister', phone: '+63 917 555 0106' };
    const me = await library.updateOwnPerson(as(ana), { emergencyContact: contact }, 1);
    expect(me.hasEmergencyContact).toBe(true);
    const before = await stored(ana.personId);
    if (!before.emergency_contact_enc) throw new Error('no ciphertext stored');
    const field = { table: 'persons', column: 'emergency_contact_enc', rowId: ana.personId };
    expect(openJson(keys, field, before.emergency_contact_enc)).toEqual(contact);

    const code = await refusal(
      library.updateOwnPerson(as(ana), { dietary: 'Vegan', emergencyContact: { masked: true } }, 2),
    );
    expect(code).toBe('masked_field_write');
    expect(await stored(ana.personId)).toEqual(before);
  });
});
