// Exit criterion 2 without the host: the admin creates a trip, adds an item and reads it
// back over HTTP; the item's create event is in the trip's chain and `tribo audit verify`
// reports every chain intact.
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, decodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createTripsService,
  startTotpEnrolment,
  verifyChains,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, createUser, totpFor, type TestDatabase } from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditVerify } from './cli/audit-verify.js';
import { CliError, type CliIo } from './cli/io.js';
import { operationHandlers } from './handlers/index.js';
import { buildServer } from './server.js';

const PASSWORD = 'correct horse battery';
const csrf = randomBytes(32);

let tdb: TestDatabase;
let app: FastifyInstance;
/** The admin's TOTP key, as an authenticator app holds it. */
let adminKey = '';

beforeAll(async () => {
  tdb = await createTestDatabase();
  const identity = createIdentityService(tdb.db, keyring(new AppKey(randomBytes(32))));
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
    }),
    ping: () => Promise.resolve(),
    logLevel: 'silent',
  });

  const enrolment = startTotpEnrolment('Tribo', 'ana');
  await identity.createAdmin(
    { requestId: 'cli-test', surface: 'system', userId: null },
    {
      username: 'ana',
      displayName: 'Ana Admin',
      password: PASSWORD,
      totpSecret: enrolment.secret,
      totpCode: totpFor(enrolment.key),
    },
  );
  adminKey = enrolment.key;
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

/** Signs in over HTTP; returns what every later request sends: the cookie and CSRF header. */
async function signIn(body: Record<string, string>) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } };
}

function cli() {
  const said: string[] = [];
  const io: CliIo = { say: (text) => said.push(text), ask: () => Promise.reject(new Error('no')) };
  return {
    said,
    run: (args: string[]) => auditVerify({ verifyAudit: (k) => verifyChains(tdb.db, k), io }, args),
  };
}

describe('walking skeleton over HTTP', () => {
  it('creates a trip, adds an item, reads it back, and the chain verifies', async () => {
    const admin = await signIn({ username: 'ana', password: PASSWORD, totp: totpFor(adminKey) });

    const trip = await app.inject({
      method: 'POST',
      url: '/v1/trips',
      ...admin,
      payload: {
        name: 'Island weekend',
        startDate: '2026-11-11',
        endDate: '2026-11-14',
        currency: 'PHP',
        timezone: 'Asia/Manila',
      },
    });
    expect(trip.statusCode).toBe(201);
    const { id: tripId } = trip.json<{ id: string }>();
    expect(trip.json()).toMatchObject({ name: 'Island weekend', status: 'draft', version: 1 });
    expect(tripId).toMatch(/^trp_/);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/trips/${tripId}/items`,
      ...admin,
      payload: {
        type: 'transport',
        title: 'Morning ferry',
        start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
      },
    });
    expect(created.statusCode).toBe(201);
    const item = created.json<{ id: string }>();
    expect(item).toMatchObject({
      tripId,
      title: 'Morning ferry',
      start: { local: '2026-11-11T07:40', tz: 'Asia/Manila', at: '2026-11-10T23:40:00.000Z' },
      end: null,
    });

    const read = await app.inject({ method: 'GET', url: `/v1/items/${item.id}`, ...admin });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(item);

    const listed = await app.inject({ method: 'GET', url: '/v1/trips', ...admin });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [trip.json()], nextCursor: null });

    const tripUuid = decodeTypeId(ID_PREFIX.trip, tripId);
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'surface', 'actor_user_id'])
      .where('entity_id', '=', decodeTypeId(ID_PREFIX.item, item.id))
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      chain_key: `trip:${tripUuid}`,
      action: 'create',
      surface: 'web',
    });

    const { said, run } = cli();
    await run([]);
    expect(said).toContain(`trip:${tripUuid}  3 events, head seq 3  intact`);
    expect(said.at(-1)).toMatch(/^All \d+ chains intact\.$/);
  });

  it('answers mfa_required to a trips.create from a session without a second factor', async () => {
    await createUser(tdb.db, { username: 'ben', password: PASSWORD });
    const ben = await signIn({ username: 'ben', password: PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/trips',
      ...ben,
      payload: {
        name: 'Ben trip',
        startDate: '2026-11-11',
        endDate: '2026-11-12',
        currency: 'PHP',
        timezone: 'Asia/Manila',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'mfa_required' });
  });

  it('answers not_found for a malformed or unknown id and needs a session', async () => {
    const admin = await signIn({ username: 'ana', password: PASSWORD, totp: totpFor(adminKey) });
    const urls = ['/v1/items/itm_nope', '/v1/items/itm_01h455vb4pex5vsknk084sn02q'];
    const responses = await Promise.all(
      urls.map((url) => app.inject({ method: 'GET', url, ...admin })),
    );
    responses.forEach((res, i) => {
      expect(res.json(), urls[i]).toMatchObject({ code: 'not_found' });
    });
    const anonymous = await app.inject({
      method: 'GET',
      url: '/v1/items/itm_01h455vb4pex5vsknk084sn02q',
    });
    expect(anonymous.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('checks trips.list query parameters and needs a session', async () => {
    const admin = await signIn({ username: 'ana', password: PASSWORD, totp: totpFor(adminKey) });
    const queries = ['limit=0', 'limit=201', 'limit=two', 'sort=name'];
    const responses = await Promise.all(
      queries.map((query) => app.inject({ method: 'GET', url: `/v1/trips?${query}`, ...admin })),
    );
    responses.forEach((res, i) => {
      expect(res.statusCode, queries[i]).toBe(400);
      expect(res.json(), queries[i]).toMatchObject({ code: 'validation_failed' });
    });
    const anonymous = await app.inject({ method: 'GET', url: '/v1/trips' });
    expect(anonymous.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('exits non-zero for an unknown chain', async () => {
    await expect(cli().run(['trip:00000000-0000-0000-0000-000000000000'])).rejects.toThrow(
      CliError,
    );
  });
});
