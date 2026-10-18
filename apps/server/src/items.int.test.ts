// The items handlers over HTTP: requests parse, services answer, views map. The rules
// behind each operation are proven against the services in packages/testkit.
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createLibraryService,
  createTripsService,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import {
  addMember,
  createItem,
  createTestDatabase,
  createTrip,
  createUser,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationHandlers } from './handlers/index.js';
import { buildServer } from './server.js';

const PASSWORD = 'correct horse battery';
const csrf = randomBytes(32);

let tdb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const keys = keyring(new AppKey(randomBytes(32)));
  const identity = createIdentityService(tdb.db, keys, 'Tribo (tribo.test)');
  const write = writePath(tdb.db);
  app = await buildServer({
    trustedProxies: ['loopback'],
    csrfSecret: csrf,
    authenticate: (token) => identity.authenticate(token),
    handlers: operationHandlers({
      identity,
      csrfSecret: csrf,
      trips: createTripsService(tdb.db, write),
      items: createItemsService(tdb.db, write, keys),
      library: createLibraryService(tdb.db, write, keys),
    }),
    ping: () => Promise.resolve(),
    logLevel: 'silent',
  });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedInUser() {
  n += 1;
  const username = `item_traveller_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    ...user,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

/** A signed-in trip owner and a signed-in viewer, with one shared item that has a cost. */
async function world() {
  const owner = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  const viewerMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: viewer.personId,
    role: 'viewer',
  });
  const itemId = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'lodging',
    title: 'Beach house',
    days: { start: '2026-11-11', end: '2026-11-13' },
    cost: { amountMinor: 1800000, currency: 'PHP' },
  });
  return {
    owner,
    viewer,
    viewerMembershipId,
    trip,
    itemId,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
    itemPath: encodeTypeId(ID_PREFIX.item, itemId),
  };
}

describe('items.list over HTTP', () => {
  it('answers a page of items, costs masked for a viewer, filters from the query string', async () => {
    const w = await world();
    const list = (user: typeof w.owner, query = '') =>
      app.inject({
        method: 'GET',
        url: `/v1/trips/${w.tripPath}/items${query}`,
        ...user.auth,
      });

    const own = await list(w.owner, '?type=lodging&from=2026-11-12&to=2026-11-12&limit=10');
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({
      items: [
        expect.objectContaining({
          id: w.itemPath,
          title: 'Beach house',
          cost: { amountMinor: 1800000, currency: 'PHP' },
          bookingRef: null,
          cardLast4: null,
        }),
      ],
      nextCursor: null,
    });
    const viewed = await list(w.viewer);
    expect(viewed.json()).toMatchObject({ items: [{ cost: { masked: true } }] });
    expect((await list(w.owner, '?type=meal')).json()).toEqual({ items: [], nextCursor: null });
  });

  it('refuses a bad filter with validation_failed and a stranger with not_found', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const bad = await app.inject({
      method: 'GET',
      url: `/v1/trips/${w.tripPath}/items?from=2026-11-13&to=2026-11-12`,
      ...w.owner.auth,
    });
    expect(bad.json()).toMatchObject({ code: 'validation_failed' });
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/trips/${w.tripPath}/items`,
      ...stranger.auth,
    });
    expect(hidden.statusCode).toBe(404);
  });
});

describe('items.update over HTTP', () => {
  it('takes If-Match as an entity tag: 428 without, 412 stale, 200 with the item', async () => {
    const w = await world();
    const patch = (ifMatchHeader?: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/items/${w.itemPath}`,
        cookies: w.owner.auth.cookies,
        headers: {
          ...w.owner.auth.headers,
          ...(ifMatchHeader === undefined ? {} : { 'if-match': ifMatchHeader }),
        },
        payload: { title: 'Beach house, sea view', bookingRef: 'BH-2026-11' },
      });
    expect((await patch()).statusCode).toBe(428);
    expect((await patch('"2"')).statusCode).toBe(412);
    const ok = await patch('"1"');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      title: 'Beach house, sea view',
      bookingRef: { masked: true },
      version: 2,
    });
  });
});
