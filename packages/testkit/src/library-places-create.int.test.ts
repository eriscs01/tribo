// @module-tag drop-a
// library.places.create (Drop A): Add place (kind, lat/lng, hours, links); Audited on platform chain (G11)
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';

let tdb: TestDatabase;
let library: LibraryService;
let n = 0;
const as = (userId: string | null): RequestContext => {
  n += 1;
  return { requestId: `req-${String(n)}`, surface: 'web', userId };
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  library = createLibraryService(tdb.db, writePath(tdb.db), keyring(new AppKey(randomBytes(32))));
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

const countPlaces = async () =>
  Number(
    (
      await tdb.db
        .selectFrom('tribo.places')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

const pier = {
  name: 'Siquijor Port',
  kind: 'port',
  location: { lat: 9.214567, lng: 123.511234 },
  address: 'Poblacion, Siquijor',
  hours: [{ day: 'mon', opens: '05:00', closes: '18:00' }],
  links: ['https://example.test/siquijor-port'],
  notes: 'Ferries from Dumaguete',
};

describe('library.places.create', () => {
  it('lets any signed-in user add a place to the shared library', async () => {
    const ana = await createUser(tdb.db);
    const place = await library.createPlace(as(ana.userId), pier);
    expect(place).toMatchObject({ ...pier, version: 1 });
    const minimal = await library.createPlace(as(ana.userId), { name: 'Salagdoong Beach' });
    expect(minimal).toMatchObject({
      name: 'Salagdoong Beach',
      kind: 'other',
      location: null,
      address: null,
      hours: null,
      links: [],
      notes: null,
    });
  });

  it('refuses a caller without an account with unauthenticated', async () => {
    const before = await countPlaces();
    expect(await refusal(library.createPlace(as(null), pier))).toBe('unauthenticated');
    expect(await countPlaces()).toBe(before);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const ana = await createUser(tdb.db);
    const before = await countPlaces();
    const bodies = [
      {},
      { name: '' },
      { name: 'Pier', kind: 'volcano' },
      { name: 'Pier', location: { lat: 9.2 } },
      { name: 'Pier', location: { lat: 91, lng: 0 } },
      { name: 'Pier', hours: [{ day: 'mon', opens: '25:00', closes: '18:00' }] },
      { name: 'Pier', links: ['ftp://example.test/pier'] },
      { name: 'Pier', mergedInto: 'plc_x' },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(library.createPlace(as(ana.userId), body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await countPlaces()).toBe(before);
  });

  it('records its audit event on the platform chain and its snapshot in the one transaction', async () => {
    const ana = await createUser(tdb.db);
    const place = await library.createPlace(as(ana.userId), pier);
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'actor_user_id', 'version_after'])
      .where('entity_id', '=', place.id)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      chain_key: 'platform',
      action: 'create',
      entity_type: 'place',
      actor_user_id: ana.userId,
      version_after: 1,
    });
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'trip_id', 'snapshot'])
      .where('entity_id', '=', place.id)
      .executeTakeFirstOrThrow();
    expect(snapshot).toEqual({ entity_type: 'place', version: 1, trip_id: null, snapshot: pier });
  });

  it('takes no Idempotency-Key in 1a: every create is a new place', async () => {
    const ana = await createUser(tdb.db);
    const first = await library.createPlace(as(ana.userId), { name: 'Lazi Church' });
    const second = await library.createPlace(as(ana.userId), { name: 'Lazi Church' });
    expect(second.id).not.toBe(first.id);
  });
});
