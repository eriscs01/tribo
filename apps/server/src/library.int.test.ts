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
