// The library and me handlers over HTTP: requests parse, services answer, views map. The
// rules behind each operation are proven against the services in packages/testkit.
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createLibraryService,
  createTripsService,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, createUser, type TestDatabase } from '@tribo/testkit';
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
      items: createItemsService(tdb.db, write),
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
  const username = `traveller_${String(n)}`;
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
    username,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

describe('library.people.create over HTTP', () => {
  it('answers 201 with the person, emergency contact masked', async () => {
    const ana = await signedInUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/library/people',
      ...ana.auth,
      payload: {
        displayName: 'Carla Cruz',
        emergencyContact: { name: 'Rosa Cruz', phone: '+63 917 555 0102' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.stringMatching(/^per_/) as unknown,
      displayName: 'Carla Cruz',
      hasAccount: false,
      contacts: {},
      dietary: null,
      drivingLicence: false,
      emergencyContact: { masked: true },
      version: 1,
    });
  });

  it('ignores an Idempotency-Key in 1a: the same request twice makes two people', async () => {
    const ana = await signedInUser();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/library/people',
        cookies: ana.auth.cookies,
        headers: { ...ana.auth.headers, 'idempotency-key': 'same-key' },
        payload: { displayName: 'Dee Dela Cruz' },
      });
    const first = await send();
    const second = await send();
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json<{ id: string }>().id).not.toBe(first.json<{ id: string }>().id);
  });

  it('needs a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/library/people',
      payload: { displayName: 'Nobody' },
    });
    expect(res.json()).toMatchObject({ code: 'unauthenticated' });
  });
});

describe('library.people.get over HTTP', () => {
  it('answers the person the caller created, and not_found to anyone else', async () => {
    const ana = await signedInUser();
    const ben = await signedInUser();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/library/people',
      ...ana.auth,
      payload: { displayName: 'Carla Cruz' },
    });
    const person = created.json<{ id: string }>();
    const read = await app.inject({
      method: 'GET',
      url: `/v1/library/people/${person.id}`,
      ...ana.auth,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(person);
    const urls = [`/v1/library/people/${person.id}`, '/v1/library/people/per_nope'];
    const responses = await Promise.all(
      urls.map((url) => app.inject({ method: 'GET', url, ...ben.auth })),
    );
    responses.forEach((res, i) => {
      expect(res.json(), urls[i]).toMatchObject({ code: 'not_found' });
    });
  });
});

describe('library.people.update over HTTP', () => {
  it('reads If-Match as the version: 428 without it, 412 when stale, 200 when current', async () => {
    const ana = await signedInUser();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/library/people',
      ...ana.auth,
      payload: { displayName: 'Carla Cruz' },
    });
    const { id } = created.json<{ id: string }>();
    const patch = (ifMatch?: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/library/people/${id}`,
        cookies: ana.auth.cookies,
        headers: { ...ana.auth.headers, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload: { dietary: 'Vegan' },
      });
    const missing = await patch();
    expect([missing.statusCode, missing.json<{ code: string }>().code]).toEqual([
      428,
      'if_match_required',
    ]);
    const stale = await patch('"2"');
    expect([stale.statusCode, stale.json<{ code: string }>().code]).toEqual([
      412,
      'version_conflict',
    ]);
    const ok = await patch('"1"');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, dietary: 'Vegan', version: 2 });
  });
});

describe('library.places.create over HTTP', () => {
  it('answers 201 with the place', async () => {
    const ana = await signedInUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/library/places',
      ...ana.auth,
      payload: {
        name: 'Cambugahay Falls',
        kind: 'landmark',
        location: { lat: 9.1405, lng: 123.6227 },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.stringMatching(/^plc_/) as unknown,
      name: 'Cambugahay Falls',
      kind: 'landmark',
      location: { lat: 9.1405, lng: 123.6227 },
      links: [],
      version: 1,
    });
  });
});

describe('library.vendors.create over HTTP', () => {
  it('answers 201 with the vendor and its place as a TypeID', async () => {
    const ana = await signedInUser();
    const place = await app.inject({
      method: 'POST',
      url: '/v1/library/places',
      ...ana.auth,
      payload: { name: 'Dumaguete Port', kind: 'port' },
    });
    const placeId = place.json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/library/vendors',
      ...ana.auth,
      payload: { name: 'Island Fast Craft', kind: 'ferry_line', placeId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.stringMatching(/^vnd_/) as unknown,
      name: 'Island Fast Craft',
      kind: 'ferry_line',
      placeId,
      contacts: {},
      version: 1,
    });
  });
});

describe('library.search over HTTP', () => {
  it('answers matches as TypeIDs and checks its query', async () => {
    const ana = await signedInUser();
    await app.inject({
      method: 'POST',
      url: '/v1/library/places',
      ...ana.auth,
      payload: { name: 'Mount Bandilaan', kind: 'landmark' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library/search?q=bandilaan',
      ...ana.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          kind: 'place',
          id: expect.stringMatching(/^plc_/) as unknown,
          name: 'Mount Bandilaan',
          placeKind: 'landmark',
        },
      ],
    });
    const queries = ['', 'q=', 'q=x&limit=0', 'q=x&limit=51', 'q=x&cursor=abc'];
    const responses = await Promise.all(
      queries.map((query) =>
        app.inject({ method: 'GET', url: `/v1/library/search?${query}`, ...ana.auth }),
      ),
    );
    responses.forEach((r, i) => {
      expect(r.json(), queries[i]).toMatchObject({ code: 'validation_failed' });
    });
  });
});

describe('me.get over HTTP', () => {
  it('answers the account and its own person', async () => {
    const ana = await signedInUser();
    const res = await app.inject({ method: 'GET', url: '/v1/me', ...ana.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      account: {
        id: expect.stringMatching(/^usr_/) as unknown,
        username: ana.username,
        platformRole: 'user',
      },
      person: {
        id: expect.stringMatching(/^per_/) as unknown,
        hasAccount: true,
        emergencyContact: null,
        version: 1,
      },
    });
    const anonymous = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(anonymous.json()).toMatchObject({ code: 'unauthenticated' });
  });
});

describe('me.update over HTTP', () => {
  it('edits the own person under If-Match and answers the whole Me', async () => {
    const ana = await signedInUser();
    const patch = (ifMatch: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: '/v1/me',
        cookies: ana.auth.cookies,
        headers: { ...ana.auth.headers, 'if-match': ifMatch },
        payload,
      });
    const ok = await patch('"1"', {
      dietary: 'Vegan',
      emergencyContact: { name: 'Rosa Reyes', phone: '+63 917 555 0106' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      account: { username: ana.username },
      person: { dietary: 'Vegan', emergencyContact: { masked: true }, version: 2 },
    });
    // Echoing the read back is refused rather than overwriting the real value.
    const echoed = await patch('"2"', { emergencyContact: { masked: true } });
    expect([echoed.statusCode, echoed.json<{ code: string }>().code]).toEqual([
      409,
      'masked_field_write',
    ]);
  });
});
