// The units and board handlers over HTTP: requests parse, services answer, views map, and
// every refusal leaves its log line. The rules behind each operation are proven against
// the services in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
  createItem,
  createTestDatabase,
  createTrip,
  createUnit,
  createUser,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices, type Services } from './runtime.js';

const PASSWORD = 'correct horse battery';

let tdb: TestDatabase;
let app: FastifyInstance;
let services: Services;
const lines: Record<string, unknown>[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://tribo.test'));
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  app = await buildApp(services, { trustedProxies: ['loopback'], logLevel: 'info', logStream });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedInUser() {
  n += 1;
  const username = `unit_traveller_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    // One client per account, so signing many in stays under the per-address login limit.
    remoteAddress: `2001:db8:${n.toString(16)}::1`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    ...user,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

type Caller = Awaited<ReturnType<typeof signedInUser>>;

/** A signed-in owner, member and viewer; a guest house with one priced room. */
async function world() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  const memberMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: member.personId,
    role: 'member',
  });
  const viewerMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: viewer.personId,
    role: 'viewer',
  });
  const itemId = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'lodging',
    title: 'Lagwerta Guest House',
    days: { start: '2026-11-11', end: '2026-11-14' },
  });
  const roomId = await createUnit(tdb.db, {
    itemId,
    label: 'Room 1',
    rate: { amountMinor: 250_000, currency: 'PHP' },
  });
  return {
    owner,
    member,
    viewer,
    trip,
    memberMembershipId,
    viewerMembershipId,
    itemId,
    roomId,
    itemPath: encodeTypeId(ID_PREFIX.item, itemId),
    roomPath: encodeTypeId(ID_PREFIX.unit, roomId),
  };
}

/** The refusal line the request left: request id, operation id and code, never values. */
function refusalLine(requestId: unknown) {
  return linesOf(requestId).find((l) => l.msg === 'request refused');
}

describe('units.list over HTTP', () => {
  it('answers a page of units, the rate masked for a viewer', async () => {
    const w = await world();
    const list = (caller: Caller, query = '') =>
      app.inject({ method: 'GET', url: `/v1/items/${w.itemPath}/units${query}`, ...caller.auth });
    const owned = await list(w.owner, '?limit=10');
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toEqual({
      items: [
        {
          id: w.roomPath,
          itemId: w.itemPath,
          kind: 'room',
          label: 'Room 1',
          capacity: 2,
          bedType: null,
          rate: { amountMinor: 250_000, currency: 'PHP' },
          position: 0,
          version: 1,
          createdAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        },
      ],
      nextCursor: null,
    });
    const viewed = await list(w.viewer);
    expect(viewed.json()).toMatchObject({ items: [{ rate: { masked: true } }] });
    expect(viewed.body).not.toContain('250000');
  });

  it('answers 404 to a stranger and logs the refusal with its operation and code', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/items/${w.itemPath}/units`,
      ...stranger.auth,
    });
    expect(res.statusCode).toBe(404);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'units.list',
      problem: 'not_found',
      status: 404,
    });
  });
});
