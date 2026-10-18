// @module-tag drop-a
// library.search (Drop A): Search people, places, vendors (trigram); People limited by person_visible
// The full person_visible rule is checked against the oracle in library-search.leak.test.ts.
import { randomBytes } from 'node:crypto';
import { createLibraryService, writePath, type LibraryService } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createPlaceholder, createTrip, createUser } from './factories.js';

let tdb: TestDatabase;
let library: LibraryService;
let n = 0;
const as = (userId: string): RequestContext => {
  n += 1;
  return { requestId: `req-${String(n)}`, surface: 'web', userId };
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  library = createLibraryService(tdb.db, writePath(tdb.db), keyring(new AppKey(randomBytes(32))));
});
afterAll(() => tdb.destroy());

const names = async (userId: string, q: string, limit = 50) =>
  (await library.search(userId, { q, limit })).map((hit) => `${hit.kind}:${hit.name}`);

describe('library.search', () => {
  it('enforces the roles column: any signed-in user finds the shared places and vendors', async () => {
    const ana = await createUser(tdb.db);
    const ben = await createUser(tdb.db);
    await library.createPlace(as(ana.userId), { name: 'Paliton Beach', kind: 'beach' });
    await library.createVendor(as(ana.userId), {
      name: 'Paliton Dive Shop',
      kind: 'tour_operator',
    });
    const hits = await library.search(ben.userId, { q: 'paliton', limit: 20 });
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'place', name: 'Paliton Beach', placeKind: 'beach' }),
        expect.objectContaining({
          kind: 'vendor',
          name: 'Paliton Dive Shop',
          vendorKind: 'tour_operator',
        }),
      ]),
    );
  });

  it('limits people to tribo.person_visible: own placeholders and co-members only', async () => {
    const ana = await createUser(tdb.db, { displayName: 'Ana Zamora' });
    const ben = await createUser(tdb.db, { displayName: 'Ben Zamora' });
    const cy = await createUser(tdb.db, { displayName: 'Cy Zamora' });
    await createPlaceholder(tdb.db, { createdBy: ana.userId, displayName: 'Dina Zamora' });
    const { tripId } = await createTrip(tdb.db, { owner: ana });
    await addMember(tdb.db, { tripId, personId: ben.personId, role: 'viewer' });

    expect((await names(ana.userId, 'zamora')).sort()).toEqual([
      'person:Ana Zamora',
      'person:Ben Zamora',
      'person:Dina Zamora',
    ]);
    expect((await names(ben.userId, 'zamora')).sort()).toEqual([
      'person:Ana Zamora',
      'person:Ben Zamora',
    ]);
    expect(await names(cy.userId, 'zamora')).toEqual(['person:Cy Zamora']);
  });

  it('matches substrings and close spellings, best first, never deleted rows', async () => {
    const ana = await createUser(tdb.db);
    await library.createPlace(as(ana.userId), { name: 'Lazi Convent' });
    await library.createPlace(as(ana.userId), { name: 'Lazi Church' });
    const gone = await library.createPlace(as(ana.userId), { name: 'Lazi Old Market' });
    await tdb.db
      .updateTable('tribo.places')
      .set({ deleted_at: new Date() })
      .where('id', '=', gone.id)
      .execute();
    expect(await names(ana.userId, 'convent')).toEqual(['place:Lazi Convent']);
    // A typo still finds it through trigram word similarity.
    expect(await names(ana.userId, 'Lazi Chuch')).toContain('place:Lazi Church');
    expect((await names(ana.userId, 'lazi')).sort()).toEqual([
      'place:Lazi Church',
      'place:Lazi Convent',
    ]);
  });

  it('treats LIKE wildcards in the query as text and honours the limit', async () => {
    const ana = await createUser(tdb.db);
    await library.createPlace(as(ana.userId), { name: 'Cafe 100% Siquijor' });
    await library.createPlace(as(ana.userId), { name: 'Cafe Siquijor' });
    expect(await names(ana.userId, '100%')).toEqual(['place:Cafe 100% Siquijor']);
    expect(await names(ana.userId, '%')).toEqual(['place:Cafe 100% Siquijor']);
    expect(await names(ana.userId, 'cafe', 1)).toHaveLength(1);
  });
});
