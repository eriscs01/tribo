// itinerary.get over HTTP: the query parses, the services answer, the view maps, and every
// refusal leaves its log line. The rules behind it are proven against the services in
// packages/testkit; here the boundaries are crossed for real (trips, items, library).
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  CSRF_HEADER,
  encodeTypeId,
  ID_PREFIX,
  SESSION_COOKIE,
  type Itinerary,
} from '@tribo/contract';
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
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';

let tdb: TestDatabase;
let app: FastifyInstance;
const lines: Record<string, unknown>[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  const services = composeServices(
    tdb.db,
    new AppKey(randomBytes(32)),
    new URL('https://tribo.test'),
  );
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
  const username = `itinerary_traveller_${String(n)}`;
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

/** A signed-in owner, member and viewer; a priced guest house and an e-bike rental. */
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
  await addMember(tdb.db, { tripId: trip.tripId, personId: viewer.personId, role: 'viewer' });
  const lodging = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'lodging',
    title: 'Lagwerta Guest House',
    days: { start: '2026-11-11', end: '2026-11-14' },
    cost: { amountMinor: 900_000, currency: 'PHP' },
  });
  const rental = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'ground',
    title: 'E-bike rental',
    days: { start: '2026-11-12', end: '2026-11-13' },
  });
  const bike = await createUnit(tdb.db, { itemId: rental, kind: 'vehicle', capacity: 5 });
  return {
    owner,
    member,
    viewer,
    trip,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
    memberMembershipId,
    lodging,
    rental,
    bike,
  };
}

const read = (w: { tripPath: string }, caller: Caller, query = '') =>
  app.inject({ method: 'GET', url: `/v1/trips/${w.tripPath}/itinerary${query}`, ...caller.auth });

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

describe('itinerary.get over HTTP', () => {
  it('answers the day timeline with type ids, local times and masked items', async () => {
    const w = await world();
    const res = await read(w, w.viewer, '?view=group&from=2026-11-14');
    expect(res.statusCode).toBe(200);
    const lodgingId = encodeTypeId(ID_PREFIX.item, w.lodging);
    expect(res.json<Itinerary>()).toEqual({
      view: 'group',
      from: '2026-11-14',
      to: null,
      days: [
        {
          date: '2026-11-14',
          entries: [{ itemId: lodgingId, part: 'check_out', time: null, tz: null }],
        },
      ],
      items: [expect.objectContaining({ id: lodgingId, cost: { masked: true } })],
      warnings: [],
    });
  });

  it('refuses a range that ends before it starts, and a trip the caller is not in, with a log line', async () => {
    const w = await world();
    const bad = await read(w, w.member, '?from=2026-11-14&to=2026-11-11');
    expect([bad.statusCode, bad.json<{ code: string }>().code]).toEqual([400, 'validation_failed']);
    expect(refusalLine(bad.headers['x-request-id'])).toMatchObject({
      operationId: 'itinerary.get',
      problem: 'validation_failed',
      status: 400,
    });
    const stranger = await signedInUser();
    const hidden = await read(w, stranger);
    expect(hidden.statusCode).toBe(404);
    expect(refusalLine(hidden.headers['x-request-id'])).toMatchObject({
      operationId: 'itinerary.get',
      problem: 'not_found',
      status: 404,
    });
    expect(JSON.stringify(linesOf(hidden.headers['x-request-id']))).not.toContain('Lagwerta');
  });

  it('follows a licence change made through me.update: the driver warning goes away', async () => {
    const w = await world();
    const board = await app.inject({
      method: 'PUT',
      url: `/v1/items/${encodeTypeId(ID_PREFIX.item, w.rental)}/assignments`,
      cookies: w.owner.auth.cookies,
      headers: { ...w.owner.auth.headers, 'if-match': '"1"' },
      payload: {
        allocations: [
          {
            membershipId: encodeTypeId(ID_PREFIX.membership, w.memberMembershipId),
            role: 'driver',
            unitId: encodeTypeId(ID_PREFIX.unit, w.bike),
          },
        ],
      },
    });
    expect(board.statusCode).toBe(200);
    const warnings = async () => (await read(w, w.viewer)).json<Itinerary>().warnings;
    expect(await warnings()).toEqual([
      {
        code: 'no_licensed_driver',
        itemId: encodeTypeId(ID_PREFIX.item, w.rental),
        unitId: encodeTypeId(ID_PREFIX.unit, w.bike),
      },
    ]);

    const licence = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      cookies: w.member.auth.cookies,
      headers: { ...w.member.auth.headers, 'if-match': '"1"' },
      payload: { drivingLicence: true },
    });
    expect(licence.statusCode).toBe(200);
    expect(await warnings()).toEqual([]);
  });

  it('follows a licence change made through library.people.update for a placeholder driver', async () => {
    const w = await world();
    const added = await app.inject({
      method: 'POST',
      url: `/v1/trips/${w.tripPath}/members`,
      ...w.owner.auth,
      payload: { person: { displayName: 'Guest Driver' }, role: 'member' },
    });
    expect(added.statusCode).toBe(201);
    const guest = added.json<{ id: string; person: { id: string } }>();
    const board = await app.inject({
      method: 'PUT',
      url: `/v1/items/${encodeTypeId(ID_PREFIX.item, w.rental)}/assignments`,
      cookies: w.owner.auth.cookies,
      headers: { ...w.owner.auth.headers, 'if-match': '"1"' },
      payload: {
        allocations: [
          { membershipId: guest.id, role: 'driver', unitId: encodeTypeId(ID_PREFIX.unit, w.bike) },
        ],
      },
    });
    expect(board.statusCode).toBe(200);
    const codes = async () =>
      (await read(w, w.member)).json<Itinerary>().warnings.map((x) => x.code);
    expect(await codes()).toEqual(['no_licensed_driver']);

    const licence = await app.inject({
      method: 'PATCH',
      url: `/v1/library/people/${guest.person.id}`,
      cookies: w.owner.auth.cookies,
      headers: { ...w.owner.auth.headers, 'if-match': '"1"' },
      payload: { drivingLicence: true },
    });
    expect(licence.statusCode).toBe(200);
    expect(await codes()).toEqual([]);
  });
});
