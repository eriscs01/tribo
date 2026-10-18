// @module-tag drop-a
// library.people.create (Drop A): Create placeholder person
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring, openJson, type Keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';

let tdb: TestDatabase;
let keys: Keyring;
let library: LibraryService;
let n = 0;
const as = (userId: string | null): RequestContext => {
  n += 1;
  return { requestId: `req-${String(n)}`, surface: 'web', userId };
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
  return error as ApiError;
}

const countPersons = async () =>
  Number(
    (
      await tdb.db
        .selectFrom('tribo.persons')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe('library.people.create', () => {
  it('lets any signed-in user create a placeholder they own', async () => {
    const ana = await createUser(tdb.db);
    const person = await library.createPerson(as(ana.userId), {
      displayName: 'Carla Cruz',
      contacts: { phone: '+63 917 555 0101' },
      dietary: 'No pork',
      drivingLicence: true,
    });
    expect(person).toMatchObject({
      displayName: 'Carla Cruz',
      hasAccount: false,
      contacts: { phone: '+63 917 555 0101' },
      dietary: 'No pork',
      drivingLicence: true,
      hasEmergencyContact: false,
      version: 1,
    });
    const row = await tdb.db
      .selectFrom('tribo.persons')
      .select(['user_id', 'created_by', 'updated_by'])
      .where('id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ user_id: null, created_by: ana.userId, updated_by: ana.userId });
  });

  it('refuses a caller without an account with unauthenticated', async () => {
    const before = await countPersons();
    const error = await refusal(library.createPerson(as(null), { displayName: 'Nobody' }));
    expect(error.code).toBe('unauthenticated');
    expect(await countPersons()).toBe(before);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const ana = await createUser(tdb.db);
    const before = await countPersons();
    const bodies = [
      {},
      { displayName: '' },
      { displayName: 'x'.repeat(121) },
      { displayName: 'Dee', hasAccount: true },
      { displayName: 'Dee', contacts: { fax: '123' } },
      { displayName: 'Dee', emergencyContact: { masked: true } },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const error = await refusal(library.createPerson(as(ana.userId), body));
      expect(error.code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await countPersons()).toBe(before);
  });

  it('stores the emergency contact encrypted to its row and never returns it', async () => {
    const ana = await createUser(tdb.db);
    const contact = { name: 'Rosa Cruz', relation: 'mother', phone: '+63 917 555 0102' };
    const person = await library.createPerson(as(ana.userId), {
      displayName: 'Carla Cruz',
      emergencyContact: contact,
    });
    expect(person.hasEmergencyContact).toBe(true);
    expect(JSON.stringify(person)).not.toContain('Rosa');
    const { emergency_contact_enc: enc } = await tdb.db
      .selectFrom('tribo.persons')
      .select('emergency_contact_enc')
      .where('id', '=', person.id)
      .executeTakeFirstOrThrow();
    if (!enc) throw new Error('no ciphertext stored');
    expect(enc.toString('utf8')).not.toContain('Rosa');
    const field = { table: 'persons', column: 'emergency_contact_enc', rowId: person.id };
    expect(openJson(keys, field, enc)).toEqual(contact);
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const ana = await createUser(tdb.db);
    const person = await library.createPerson(as(ana.userId), {
      displayName: 'Carla Cruz',
      emergencyContact: { name: 'Rosa Cruz', phone: '+63 917 555 0102' },
    });
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'actor_user_id', 'version_after'])
      .where('entity_id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      chain_key: 'platform',
      action: 'create',
      entity_type: 'person',
      actor_user_id: ana.userId,
      version_after: 1,
    });
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'trip_id', 'snapshot'])
      .where('entity_id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({ entity_type: 'person', version: 1, trip_id: null });
    expect(snapshot.snapshot).toMatchObject({ userId: null, displayName: 'Carla Cruz' });
    // Ciphertext stays ciphertext in the snapshot.
    expect(JSON.stringify(snapshot.snapshot)).not.toContain('Rosa');
  });

  it('takes no Idempotency-Key in 1a: every create is a new person', async () => {
    const ana = await createUser(tdb.db);
    const body = { displayName: 'Carla Cruz' };
    const first = await library.createPerson(as(ana.userId), body);
    const second = await library.createPerson(as(ana.userId), body);
    expect(second.id).not.toBe(first.id);
  });
});
