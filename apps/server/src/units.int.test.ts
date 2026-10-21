// The units and board handlers over HTTP: requests parse, services answer, views map, and
// every refusal leaves its log line. The rules behind each operation are proven against
// the services in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addAllocation,
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

describe('units.create over HTTP', () => {
  const create = (w: Awaited<ReturnType<typeof world>>, caller: Caller, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/items/${w.itemPath}/units`,
      payload: payload as Record<string, unknown>,
      ...caller.auth,
      headers: { ...caller.auth.headers, 'idempotency-key': 'room-2' },
    });

  it('answers 201 with the unit, and ignores an Idempotency-Key in 1a', async () => {
    const w = await world();
    const body = { kind: 'room', label: 'Room 2', capacity: 3, bedType: 'twin' };
    const res = await create(w, w.owner, body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      itemId: w.itemPath,
      kind: 'room',
      label: 'Room 2',
      capacity: 3,
      bedType: 'twin',
      rate: null,
      version: 1,
    });
    // No replay: the same request again is a second create, refused for its label.
    const again = await create(w, w.owner, body);
    expect(again.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('logs a forbidden create and a bad body by operation and code, never the values sent', async () => {
    const w = await world();
    const refused = await create(w, w.viewer, { kind: 'room', label: 'Room 9', capacity: 2 });
    expect(refused.statusCode).toBe(403);
    expect(refusalLine(refused.headers['x-request-id'])).toMatchObject({
      operationId: 'units.create',
      problem: 'forbidden',
      status: 403,
    });
    const bad = await create(w, w.owner, { kind: 'room', label: 'Secret Suite X', capacity: 0 });
    expect(bad.statusCode).toBe(400);
    expect(refusalLine(bad.headers['x-request-id'])).toMatchObject({
      operationId: 'units.create',
      problem: 'validation_failed',
    });
    expect(JSON.stringify(linesOf(bad.headers['x-request-id']))).not.toContain('Secret Suite X');
  });
});

describe('units.update over HTTP', () => {
  it('takes If-Match as an entity tag: 428 without, 200 with the unit', async () => {
    const w = await world();
    const patch = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/units/${w.roomPath}`,
        payload,
        ...w.owner.auth,
        headers: { ...w.owner.auth.headers, ...headers },
      });
    expect((await patch({}, { capacity: 3 })).statusCode).toBe(428);
    const res = await patch({ 'if-match': '"1"' }, { capacity: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: w.roomPath, capacity: 3, version: 2 });
  });

  it('logs capacity_exceeded by operation and code', async () => {
    const w = await world();
    for (const membershipId of [w.memberMembershipId, w.viewerMembershipId]) {
      // eslint-disable-next-line no-await-in-loop -- rows go in one by one
      await addAllocation(tdb.db, {
        tripId: w.trip.tripId,
        itemId: w.itemId,
        membershipId,
        role: 'occupant',
        unitId: w.roomId,
      });
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/units/${w.roomPath}`,
      payload: { capacity: 1 },
      ...w.owner.auth,
      headers: { ...w.owner.auth.headers, 'if-match': '"1"' },
    });
    expect(res.statusCode).toBe(409);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'units.update',
      problem: 'capacity_exceeded',
      status: 409,
    });
  });
});

describe('units.delete over HTTP', () => {
  it('answers 204 under If-Match, and the unit leaves the list', async () => {
    const w = await world();
    const del = (headers: Record<string, string>) =>
      app.inject({
        method: 'DELETE',
        url: `/v1/units/${w.roomPath}`,
        ...w.owner.auth,
        headers: { ...w.owner.auth.headers, ...headers },
      });
    const stale = await del({ 'if-match': '"9"' });
    expect(stale.statusCode).toBe(412);
    expect(refusalLine(stale.headers['x-request-id'])).toMatchObject({
      operationId: 'units.delete',
      problem: 'version_conflict',
    });
    expect((await del({ 'if-match': '"1"' })).statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/items/${w.itemPath}/units`,
      ...w.owner.auth,
    });
    expect(list.json()).toEqual({ items: [], nextCursor: null });
  });
});

describe('items.assignments.get over HTTP', () => {
  it('answers the board with ETag = boardVersion, and 304 while it is current', async () => {
    const w = await world();
    await addAllocation(tdb.db, {
      tripId: w.trip.tripId,
      itemId: w.itemId,
      membershipId: w.memberMembershipId,
      role: 'occupant',
      unitId: w.roomId,
    });
    const get = (headers: Record<string, string> = {}) =>
      app.inject({
        method: 'GET',
        url: `/v1/items/${w.itemPath}/assignments`,
        ...w.viewer.auth,
        headers: { ...w.viewer.auth.headers, ...headers },
      });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json()).toEqual({
      itemId: w.itemPath,
      boardVersion: 1,
      allocations: [
        {
          membershipId: encodeTypeId(ID_PREFIX.membership, w.memberMembershipId),
          role: 'occupant',
          unitId: w.roomPath,
          rsvp: null,
        },
      ],
      warnings: [],
    });
    expect((await get({ 'if-none-match': '"1"' })).statusCode).toBe(304);
  });

  it('answers 404 to a stranger and logs the refusal', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/items/${w.itemPath}/assignments`,
      ...stranger.auth,
    });
    expect(res.statusCode).toBe(404);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'items.assignments.get',
      problem: 'not_found',
    });
  });
});

describe('items.assignments.replace over HTTP', () => {
  const put = (
    w: Awaited<ReturnType<typeof world>>,
    caller: Caller,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'PUT',
      url: `/v1/items/${w.itemPath}/assignments`,
      payload: payload as Record<string, unknown>,
      ...caller.auth,
      headers: { ...caller.auth.headers, ...headers },
    });
  const occupant = (membershipId: string, roomPath: string) => ({
    membershipId: encodeTypeId(ID_PREFIX.membership, membershipId),
    role: 'occupant',
    unitId: roomPath,
  });

  it('saves the board with the ETag the read sent as If-Match, and answers the new board', async () => {
    const w = await world();
    const read = await app.inject({
      method: 'GET',
      url: `/v1/items/${w.itemPath}/assignments`,
      ...w.owner.auth,
    });
    const body = { allocations: [occupant(w.memberMembershipId, w.roomPath)] };
    expect((await put(w, w.owner, body)).statusCode).toBe(428);
    const res = await put(w, w.owner, body, { 'if-match': String(read.headers.etag) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemId: w.itemPath, boardVersion: 2, warnings: [] });
    const stale = await put(w, w.owner, body, { 'if-match': String(read.headers.etag) });
    expect(stale.statusCode).toBe(412);
  });

  it('logs capacity_exceeded and room_double_booked by operation and code', async () => {
    const w = await world();
    const third = await signedInUser();
    const thirdMembershipId = await addMember(tdb.db, {
      tripId: w.trip.tripId,
      personId: third.personId,
      role: 'member',
    });
    const full = [w.memberMembershipId, w.viewerMembershipId, thirdMembershipId].map((m) =>
      occupant(m, w.roomPath),
    );
    const over = await put(w, w.owner, { allocations: full }, { 'if-match': '"1"' });
    expect(over.statusCode).toBe(409);
    expect(refusalLine(over.headers['x-request-id'])).toMatchObject({
      operationId: 'items.assignments.replace',
      problem: 'capacity_exceeded',
      status: 409,
    });
    const room2 = await createUnit(tdb.db, { itemId: w.itemId, label: 'Room 2' });
    const twice = [
      occupant(w.memberMembershipId, w.roomPath),
      occupant(w.memberMembershipId, encodeTypeId(ID_PREFIX.unit, room2)),
    ];
    const booked = await put(w, w.owner, { allocations: twice }, { 'if-match': '"1"' });
    expect(refusalLine(booked.headers['x-request-id'])).toMatchObject({
      operationId: 'items.assignments.replace',
      problem: 'room_double_booked',
      status: 409,
    });
  });

  it('logs driver_taken and a forbidden save by operation and code', async () => {
    const owner = await signedInUser();
    const member = await signedInUser();
    const trip = await createTrip(tdb.db, { owner });
    const memberMembershipId = await addMember(tdb.db, {
      tripId: trip.tripId,
      personId: member.personId,
      role: 'member',
    });
    const rental = await createItem(tdb.db, {
      tripId: trip.tripId,
      ownerMembershipId: trip.ownerMembershipId,
      type: 'ground',
    });
    const bike = encodeTypeId(
      ID_PREFIX.unit,
      await createUnit(tdb.db, { itemId: rental, kind: 'vehicle', capacity: 5 }),
    );
    const driver = (m: string) => ({
      membershipId: encodeTypeId(ID_PREFIX.membership, m),
      role: 'driver',
      unitId: bike,
    });
    const save = (caller: Caller) =>
      app.inject({
        method: 'PUT',
        url: `/v1/items/${encodeTypeId(ID_PREFIX.item, rental)}/assignments`,
        payload: { allocations: [driver(trip.ownerMembershipId), driver(memberMembershipId)] },
        ...caller.auth,
        headers: { ...caller.auth.headers, 'if-match': '"1"' },
      });
    const taken = await save(owner);
    expect(refusalLine(taken.headers['x-request-id'])).toMatchObject({
      operationId: 'items.assignments.replace',
      problem: 'driver_taken',
      status: 409,
    });
    const forbidden = await save(member);
    expect(refusalLine(forbidden.headers['x-request-id'])).toMatchObject({
      operationId: 'items.assignments.replace',
      problem: 'forbidden',
      status: 403,
    });
  });
});
