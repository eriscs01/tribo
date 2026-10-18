// The trips handlers over HTTP: requests parse, services answer, views map, headers carry
// the ETag and If-Match. The rules behind each operation are proven against the service
// in packages/testkit.
import { createHash, randomBytes } from 'node:crypto';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createLibraryService,
  createTripsService,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, createTrip, createUser, type TestDatabase } from '@tribo/testkit';
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
/** A new account owning a new trip, signed in over HTTP. */
async function ownerWithTrip() {
  n += 1;
  const username = `organiser_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const { tripId } = await createTrip(tdb.db, { owner: user, name: 'Bohol long weekend' });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    url: `/v1/trips/${encodeTypeId(ID_PREFIX.trip, tripId)}`,
    cookies: { [SESSION_COOKIE]: token },
    headers: { [CSRF_HEADER]: csrfToken },
  };
}

describe('trips.get over HTTP', () => {
  it('answers 200 with the trip and an ETag that is the SHA-256 of the body', async () => {
    const owner = await ownerWithTrip();
    const res = await app.inject({ method: 'GET', url: owner.url, cookies: owner.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: owner.url.split('/').at(-1),
      name: 'Bohol long weekend',
      destinations: [],
      version: 1,
    });
    const digest = createHash('sha256').update(res.body).digest('base64url');
    expect(res.headers.etag).toBe(`"${digest}"`);
  });

  it('answers 304 with no body when If-None-Match names the current ETag', async () => {
    const owner = await ownerWithTrip();
    const first = await app.inject({ method: 'GET', url: owner.url, cookies: owner.cookies });
    const etag = String(first.headers.etag);
    const again = await app.inject({
      method: 'GET',
      url: owner.url,
      cookies: owner.cookies,
      headers: { 'if-none-match': `W/${etag}` },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
  });

  it('answers 404 not_found for a malformed trip id', async () => {
    const owner = await ownerWithTrip();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/trips/trp_nope',
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('trips.update over HTTP', () => {
  it('answers 428 if_match_required without If-Match', async () => {
    const owner = await ownerWithTrip();
    const { cookies, headers, url } = owner;
    const res = await app.inject({ method: 'PATCH', url, cookies, headers, payload: {} });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ code: 'if_match_required' });
  });

  it('answers 200 with the edited trip when If-Match names its version', async () => {
    const owner = await ownerWithTrip();
    const res = await app.inject({
      method: 'PATCH',
      url: owner.url,
      cookies: owner.cookies,
      headers: { ...owner.headers, 'if-match': '"1"' },
      payload: { name: 'Bohol and Panglao' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Bohol and Panglao', version: 2 });
  });

  it('answers 412 version_conflict when If-Match is stale', async () => {
    const owner = await ownerWithTrip();
    const res = await app.inject({
      method: 'PATCH',
      url: owner.url,
      cookies: owner.cookies,
      headers: { ...owner.headers, 'if-match': 'W/"7"' },
      payload: { name: 'Too late' },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'version_conflict' });
  });
});
