// @module-tag drop-a
// library.people.update (Drop A): Edit person; masked_field_write; Placeholders only (account persons use me.update); ID/passport fields join in 1b and need recorded consent; Emergency contact stored encrypted (emergency_contact_enc, R5)
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring, openJson, type Keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTrip, createUser, type UserFixture } from './factories.js';

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

/** A placeholder its creator put in a trip with a co-member, plus an outsider. */
async function world() {
  const creator = await createUser(tdb.db);
  const coMember = await createUser(tdb.db);
  const outsider = await createUser(tdb.db);
  const placeholder = await library.createPerson(as(creator), {
    displayName: 'Carla Cruz',
    contacts: { phone: '+63 917 555 0101', messenger: 'carla.cruz' },
    dietary: 'No pork',
  });
  const { tripId } = await createTrip(tdb.db, { owner: creator });
  await addMember(tdb.db, { tripId, personId: coMember.personId, role: 'organizer' });
  await addMember(tdb.db, { tripId, personId: placeholder.id, role: 'member' });
  return { creator, coMember, outsider, placeholder };
}

const events = (personId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select(['chain_key', 'action', 'entity_type', 'version_before', 'version_after'])
    .where('entity_id', '=', personId)
    .orderBy('seq')
    .execute();

const stored = (personId: string) =>
  tdb.db
    .selectFrom('tribo.persons')
    .select(['version', 'display_name', 'emergency_contact_enc', 'updated_by'])
    .where('id', '=', personId)
    .executeTakeFirstOrThrow();

describe('library.people.update', () => {
  it('lets the creator merge-patch their placeholder', async () => {
    const w = await world();
    const updated = await library.updatePerson(
      as(w.creator),
      w.placeholder.id,
      {
        displayName: 'Carla M. Cruz',
        contacts: { messenger: null, email: 'carla@example.test' },
        dietary: null,
      },
      1,
    );
    expect(updated).toMatchObject({
      displayName: 'Carla M. Cruz',
      contacts: { phone: '+63 917 555 0101', email: 'carla@example.test' },
      dietary: null,
      drivingLicence: false,
      version: 2,
    });
    expect(updated.contacts).not.toHaveProperty('messenger');
    expect((await stored(w.placeholder.id)).updated_by).toBe(w.creator.userId);
  });

  it('enforces the roles column: creator of a placeholder only; account persons use me.update', async () => {
    const w = await world();
    const body = { dietary: 'Vegan' };
    // A co-member sees the placeholder but did not create it.
    expect(await refusal(library.updatePerson(as(w.coMember), w.placeholder.id, body, 1))).toBe(
      'forbidden',
    );
    // Someone who cannot see it gets nothing that says it exists.
    expect(await refusal(library.updatePerson(as(w.outsider), w.placeholder.id, body, 1))).toBe(
      'not_found',
    );
    // Account persons, the caller's own and a co-member's, go through me.update.
    expect(await refusal(library.updatePerson(as(w.creator), w.creator.personId, body, 1))).toBe(
      'person_has_account',
    );
    expect(await refusal(library.updatePerson(as(w.creator), w.coMember.personId, body, 1))).toBe(
      'person_has_account',
    );
    expect(await refusal(library.updatePerson(as(w.outsider), w.coMember.personId, body, 1))).toBe(
      'not_found',
    );
    expect((await stored(w.placeholder.id)).version).toBe(1);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await world();
    const bodies = [
      { displayName: '' },
      { displayName: null },
      { contacts: { fax: '1' } },
      { emergencyContact: { name: 'Rosa' } },
      { hasAccount: true },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(library.updatePerson(as(w.creator), w.placeholder.id, body, 1));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect((await stored(w.placeholder.id)).version).toBe(1);
    expect(await events(w.placeholder.id)).toHaveLength(1);
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await world();
    const edit = (ifMatch: number | undefined) =>
      library.updatePerson(as(w.creator), w.placeholder.id, { dietary: 'Vegan' }, ifMatch);
    expect(await refusal(edit(undefined))).toBe('if_match_required');
    expect(await refusal(edit(2))).toBe('version_conflict');
    expect(await refusal(edit(Number.NaN))).toBe('version_conflict');
    await expect(edit(1)).resolves.toMatchObject({ version: 2 });
    expect(await refusal(edit(1))).toBe('version_conflict');
    expect((await stored(w.placeholder.id)).version).toBe(2);
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await world();
    await library.updatePerson(as(w.creator), w.placeholder.id, { drivingLicence: true }, 1);
    expect(await events(w.placeholder.id)).toEqual([
      {
        chain_key: 'platform',
        action: 'create',
        entity_type: 'person',
        version_before: null,
        version_after: 1,
      },
      {
        chain_key: 'platform',
        action: 'update',
        entity_type: 'person',
        version_before: 1,
        version_after: 2,
      },
    ]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'trip_id', 'snapshot'])
      .where('entity_id', '=', w.placeholder.id)
      .where('version', '=', 2)
      .executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({
      entity_type: 'person',
      trip_id: null,
      snapshot: { displayName: 'Carla Cruz', drivingLicence: true, dietary: 'No pork' },
    });
  });

  it('answers masked_field_write to a write of the masked emergency contact, writing nothing', async () => {
    const w = await world();
    await library.updatePerson(
      as(w.creator),
      w.placeholder.id,
      { emergencyContact: { name: 'Rosa Cruz', phone: '+63 917 555 0102' } },
      1,
    );
    const before = await stored(w.placeholder.id);
    const code = await refusal(
      library.updatePerson(
        as(w.creator),
        w.placeholder.id,
        { emergencyContact: { masked: true } },
        2,
      ),
    );
    expect(code).toBe('masked_field_write');
    expect(await stored(w.placeholder.id)).toEqual(before);
  });

  it('stores a new emergency contact encrypted, keeps it when absent and clears it with null', async () => {
    const w = await world();
    const contact = { name: 'Rosa Cruz', relation: 'mother', phone: '+63 917 555 0102' };
    const set = await library.updatePerson(
      as(w.creator),
      w.placeholder.id,
      { emergencyContact: contact },
      1,
    );
    expect(set.hasEmergencyContact).toBe(true);
    const enc = (await stored(w.placeholder.id)).emergency_contact_enc;
    if (!enc) throw new Error('no ciphertext stored');
    const field = { table: 'persons', column: 'emergency_contact_enc', rowId: w.placeholder.id };
    expect(openJson(keys, field, enc)).toEqual(contact);

    await library.updatePerson(as(w.creator), w.placeholder.id, { dietary: 'Vegan' }, 2);
    expect((await stored(w.placeholder.id)).emergency_contact_enc).toEqual(enc);

    const cleared = await library.updatePerson(
      as(w.creator),
      w.placeholder.id,
      { emergencyContact: null },
      3,
    );
    expect(cleared.hasEmergencyContact).toBe(false);
    expect((await stored(w.placeholder.id)).emergency_contact_enc).toBeNull();
  });
});
