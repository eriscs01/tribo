// The tickets handlers over HTTP: ids named as the API names them, the ticket number only ever
// masked, replies kept out of shared caches, preconditions read from the headers, and no line a
// request leaves holds a ticket number, a seat or a baggage value. The rules behind each
// operation are proven against the service in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey, keyring } from '@tribo/crypto';
import {
  addMember,
  createItem,
  createTicket,
  createTestDatabase,
  createTrip,
  createUser,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';
/** Words no other part of a log line could hold by chance. */
const TICKET_NO = 'PNR-ORCHID-4471';
const SEAT = 'Row 41 Seat K';
const ADD_ON = 'surfboard in the hold';
const NEW_TICKET_NO = 'PNR-LANTERN-9082';

let tdb: TestDatabase;
let app: FastifyInstance;
let appKey: AppKey;
const lines: Record<string, unknown>[] = [];
const raw: string[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  appKey = new AppKey(randomBytes(32));
  const services = composeServices(tdb.db, appKey, new URL('https://tribo.test'));
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      raw.push(line);
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
  const username = `night_ferrier_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress: `2001:db8:f${n.toString(16)}::1`,
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

/** A trip with a signed-in owner, member, other member and viewer, and a shared ferry the owner holds. */
async function world() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const other = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  const membership = (user: Caller, role: 'member' | 'viewer') =>
    addMember(tdb.db, { tripId: trip.tripId, personId: user.personId, role });
  const memberMembershipId = await membership(member, 'member');
  const otherMembershipId = await membership(other, 'member');
  await membership(viewer, 'viewer');
  const itemId = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'transport',
    title: 'Ferry to Coco Grove',
  });
  return {
    owner,
    member,
    other,
    viewer,
    trip,
    memberMembershipId,
    otherMembershipId,
    itemId,
    itemPath: encodeTypeId(ID_PREFIX.item, itemId),
    memberPath: encodeTypeId(ID_PREFIX.membership, memberMembershipId),
    otherPath: encodeTypeId(ID_PREFIX.membership, otherMembershipId),
  };
}

type World = Awaited<ReturnType<typeof world>>;

const ticketsUrl = (w: World) => `/v1/items/${w.itemPath}/tickets`;

/** The member's ticket on the ferry, written straight into the table. */
const memberTicket = (w: World) =>
  createTicket(tdb.db, keyring(appKey), {
    tripId: w.trip.tripId,
    itemId: w.itemId,
    membershipId: w.memberMembershipId,
    seat: SEAT,
    ticketNo: TICKET_NO,
    baggage: { checked_kg: 23, add_ons: [ADD_ON] },
  });

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

/** No line the request logged holds a ticket number, a seat or a baggage value. */
function logsNoTicket(requestId: unknown) {
  const mine = raw.filter((l) => l.includes(String(requestId)));
  expect(mine.length).toBeGreaterThan(0);
  for (const line of mine) {
    for (const secret of [TICKET_NO, 'ORCHID', NEW_TICKET_NO, 'LANTERN', SEAT, 'Seat K', ADD_ON]) {
      expect(line).not.toContain(secret);
    }
  }
}

describe('tickets.list over HTTP', () => {
  const get = (w: World, caller: Caller, query = '') =>
    app.inject({ method: 'GET', url: ticketsUrl(w) + query, cookies: caller.auth.cookies });

  it('answers 200 with the tickets, ids named as the API names them, the number masked, kept from shared caches', async () => {
    const w = await world();
    const id = await memberTicket(w);
    const res = await get(w, w.viewer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      items: [
        {
          id: encodeTypeId(ID_PREFIX.ticket, id),
          itemId: w.itemPath,
          passenger: w.memberPath,
          seat: SEAT,
          ticketNo: { masked: true },
          baggage: { checkedKg: 23, cabinKg: null, addOns: [ADD_ON] },
          version: 1,
          createdAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        },
      ],
      nextCursor: null,
    });
    expect(res.body).not.toContain(TICKET_NO);
    logsNoTicket(res.headers['x-request-id']);
  });

  it('pages with limit and cursor', async () => {
    const w = await world();
    await memberTicket(w);
    await createTicket(tdb.db, keyring(appKey), {
      tripId: w.trip.tripId,
      itemId: w.itemId,
      membershipId: w.otherMembershipId,
    });
    const first = await get(w, w.owner, '?limit=1');
    const { nextCursor, items } = first.json<{ nextCursor: string; items: unknown[] }>();
    expect(items).toHaveLength(1);
    const second = await get(w, w.owner, `?limit=1&cursor=${nextCursor}`);
    expect(second.json<{ items: unknown[]; nextCursor: null }>()).toMatchObject({
      items: [expect.objectContaining({ passenger: w.otherPath })],
      nextCursor: null,
    });
  });

  it('logs a refusal by operation and code: an item the caller cannot see is not_found, a bad id too', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await get(w, stranger);
    expect(res.statusCode).toBe(404);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'tickets.list',
      problem: 'not_found',
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/items/not-an-id/tickets',
      cookies: w.member.auth.cookies,
    });
    expect(malformed.statusCode).toBe(404);
  });
});
