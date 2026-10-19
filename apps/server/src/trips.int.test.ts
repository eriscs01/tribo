// The trips handlers over HTTP: requests parse, services answer, views map, headers carry
// the ETag and If-Match. The rules behind each operation are proven against the service
// in packages/testkit.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import { createTestDatabase, createTrip, createUser, type TestDatabase } from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices, type Services } from './runtime.js';

const PASSWORD = 'correct horse battery';

let tdb: TestDatabase;
let app: FastifyInstance;
let services: Services;

beforeAll(async () => {
  tdb = await createTestDatabase();
  services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://tribo.test'));
  app = await buildApp(services, { trustedProxies: ['loopback'], logLevel: 'silent' });
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

  it('takes library places as destinations, in order, and reads them back as the same TypeIDs', async () => {
    const owner = await ownerWithTrip();
    const auth = { cookies: owner.cookies, headers: owner.headers };
    const place = async (name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/library/places',
        ...auth,
        payload: { name, kind: 'landmark' },
      });
      expect(res.statusCode).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const destinations = [await place('Chocolate Hills'), await place('Alona Beach')];
    const res = await app.inject({
      method: 'PATCH',
      url: owner.url,
      cookies: owner.cookies,
      headers: { ...owner.headers, 'if-match': '"1"' },
      payload: { destinations },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ destinations, version: 2 });
    const read = await app.inject({ method: 'GET', url: owner.url, ...auth });
    expect(read.json()).toMatchObject({ destinations });
  });

  it('answers validation_failed for a destination that is not a place in the library', async () => {
    const owner = await ownerWithTrip();
    const res = await app.inject({
      method: 'PATCH',
      url: owner.url,
      cookies: owner.cookies,
      headers: { ...owner.headers, 'if-match': '"1"' },
      payload: { destinations: [encodeTypeId(ID_PREFIX.place, randomUUID())] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: '/destinations', message: 'not a place in the library' }],
    });
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

describe('trips.delete over HTTP', () => {
  it('answers 428 if_match_required without If-Match', async () => {
    const { cookies, headers, url } = await ownerWithTrip();
    const res = await app.inject({ method: 'DELETE', url, cookies, headers });
    expect(res.statusCode).toBe(428);
  });

  it('answers 204 with no body, after which the trip is not_found', async () => {
    const { cookies, headers, url } = await ownerWithTrip();
    const res = await app.inject({
      method: 'DELETE',
      url,
      cookies,
      headers: { ...headers, 'if-match': '"1"' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await app.inject({ method: 'GET', url, cookies })).statusCode).toBe(404);
  });
});
