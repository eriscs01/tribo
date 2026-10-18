// @module-tag drop-a
// library.vendors.create (Drop A): Add vendor (kind, contacts, links); Audited on platform chain (G11)
import { randomBytes } from 'node:crypto';
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
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
const plc = (id: string) => encodeTypeId(ID_PREFIX.place, id);

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

const countVendors = async () =>
  Number(
    (
      await tdb.db
        .selectFrom('tribo.vendors')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

const ferry = {
  name: 'Island Fast Craft',
  kind: 'ferry_line',
  contacts: { phone: '+63 35 555 0100', messenger: 'islandfastcraft' },
  links: ['https://example.test/island-fast-craft'],
  notes: 'Book the 07:40 trip a day ahead',
};

describe('library.vendors.create', () => {
  it('lets any signed-in user add a vendor, optionally at a place', async () => {
    const ana = await createUser(tdb.db);
    const port = await library.createPlace(as(ana.userId), { name: 'Dumaguete Port' });
    const vendor = await library.createVendor(as(ana.userId), { ...ferry, placeId: plc(port.id) });
    expect(vendor).toMatchObject({ ...ferry, placeId: port.id, version: 1 });
    const minimal = await library.createVendor(as(ana.userId), { name: 'Coco Grove Resort' });
    expect(minimal).toMatchObject({
      kind: 'other',
      placeId: null,
      contacts: {},
      links: [],
      notes: null,
    });
  });

  it('points a merged place id at its survivor', async () => {
    const ana = await createUser(tdb.db);
    const survivor = await library.createPlace(as(ana.userId), { name: 'Larena Port' });
    const duplicate = await library.createPlace(as(ana.userId), { name: 'Larena Pier' });
    await tdb.db
      .updateTable('tribo.places')
      .set({ merged_into: survivor.id, deleted_at: new Date() })
      .where('id', '=', duplicate.id)
      .execute();
    const vendor = await library.createVendor(as(ana.userId), {
      name: 'Larena Tricycles',
      placeId: plc(duplicate.id),
    });
    expect(vendor.placeId).toBe(survivor.id);
  });

  it('refuses a caller without an account with unauthenticated', async () => {
    const before = await countVendors();
    expect(await refusal(library.createVendor(as(null), ferry))).toBe('unauthenticated');
    expect(await countVendors()).toBe(before);
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const ana = await createUser(tdb.db);
    const gone = await library.createPlace(as(ana.userId), { name: 'Old Pier' });
    await tdb.db
      .updateTable('tribo.places')
      .set({ deleted_at: new Date() })
      .where('id', '=', gone.id)
      .execute();
    const before = await countVendors();
    const bodies = [
      {},
      { name: '' },
      { name: 'Vans', kind: 'spaceship' },
      { name: 'Vans', contacts: { phone: '1' } },
      { name: 'Vans', placeId: 'per_01h455vb4pex5vsknk084sn02q' },
      { name: 'Vans', placeId: plc('01900000-0000-7000-8000-000000000000') },
      { name: 'Vans', placeId: plc(gone.id) },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(library.createVendor(as(ana.userId), body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await countVendors()).toBe(before);
  });

  it('records its audit event on the platform chain and its snapshot in the one transaction', async () => {
    const ana = await createUser(tdb.db);
    const vendor = await library.createVendor(as(ana.userId), ferry);
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'actor_user_id', 'version_after'])
      .where('entity_id', '=', vendor.id)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      chain_key: 'platform',
      action: 'create',
      entity_type: 'vendor',
      actor_user_id: ana.userId,
      version_after: 1,
    });
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'trip_id', 'snapshot'])
      .where('entity_id', '=', vendor.id)
      .executeTakeFirstOrThrow();
    expect(snapshot).toEqual({
      entity_type: 'vendor',
      version: 1,
      trip_id: null,
      snapshot: { ...ferry, placeId: null },
    });
  });

  it('takes no Idempotency-Key in 1a: every create is a new vendor', async () => {
    const ana = await createUser(tdb.db);
    const first = await library.createVendor(as(ana.userId), { name: 'Habal-habal' });
    const second = await library.createVendor(as(ana.userId), { name: 'Habal-habal' });
    expect(second.id).not.toBe(first.id);
  });
});
