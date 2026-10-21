// The members handlers over HTTP: requests parse, services answer, views map, refusals log.
// The rules behind each operation are proven against the service in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
  createPlaceholder,
  createTestDatabase,
  createTrip,
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
  const username = `member_traveller_${String(n)}`;
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

/** A signed-in owner and viewer in one trip, with a placeholder traveller. */
async function world() {
  const owner = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  const viewerMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: viewer.personId,
    role: 'viewer',
  });
  const guestId = await createPlaceholder(tdb.db, {
    createdBy: owner.userId,
    displayName: 'Lito',
  });
  const guestMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: guestId,
    role: 'member',
  });
  return {
    owner,
    viewer,
    trip,
    guestId,
    viewerMembershipId,
    guestMembershipId,
    membersUrl: `/v1/trips/${encodeTypeId(ID_PREFIX.trip, trip.tripId)}/members`,
  };
}

describe('members.list over HTTP', () => {
  it('answers a page of members with TypeIDs, roles and people, placeholders included', async () => {
    const w = await world();
    const res = await app.inject({
      method: 'GET',
      url: `${w.membersUrl}?limit=2`,
      ...w.viewer.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toEqual([
      expect.objectContaining({
        id: encodeTypeId(ID_PREFIX.membership, w.trip.ownerMembershipId),
        tripId: encodeTypeId(ID_PREFIX.trip, w.trip.tripId),
        role: 'owner',
        canViewCosts: true,
        person: expect.objectContaining({
          id: encodeTypeId(ID_PREFIX.person, w.owner.personId),
          hasAccount: true,
          emergencyContact: null,
        }) as unknown,
      }),
      expect.objectContaining({
        id: encodeTypeId(ID_PREFIX.membership, w.viewerMembershipId),
        role: 'viewer',
        canViewCosts: false,
      }),
    ]);
    const next = await app.inject({
      method: 'GET',
      url: `${w.membersUrl}?limit=2&cursor=${String(body.nextCursor)}`,
      ...w.viewer.auth,
    });
    expect(next.json()).toEqual({
      items: [
        expect.objectContaining({
          id: encodeTypeId(ID_PREFIX.membership, w.guestMembershipId),
          person: expect.objectContaining({ displayName: 'Lito', hasAccount: false }) as unknown,
        }),
      ],
      nextCursor: null,
    });
  });

  it('answers a stranger 404 not_found and logs the refusal with its request id and operation', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await app.inject({ method: 'GET', url: w.membersUrl, ...stranger.auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
    const refused = linesOf(res.headers['x-request-id']).find((l) => l.msg === 'request refused');
    expect(refused).toMatchObject({
      level: 30,
      operationId: 'members.list',
      problem: 'not_found',
      status: 404,
    });
  });
});
