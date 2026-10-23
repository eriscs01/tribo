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
const NEW_SEAT = 'Row 7 Seat Q';

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
    for (const secret of [
      TICKET_NO,
      'ORCHID',
      NEW_TICKET_NO,
      'LANTERN',
      SEAT,
      'Seat K',
      NEW_SEAT,
      'Seat Q',
      ADD_ON,
    ]) {
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

describe('tickets.create over HTTP', () => {
  const create = (w: World, caller: Caller, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: ticketsUrl(w),
      payload: body as object,
      cookies: caller.auth.cookies,
      headers: { ...caller.auth.headers, ...headers },
    });
  const ticket = (w: World, overrides: Record<string, unknown> = {}) => ({
    passenger: w.memberPath,
    seat: SEAT,
    ticketNo: TICKET_NO,
    baggage: { checkedKg: 23, addOns: [ADD_ON] },
    ...overrides,
  });

  it('answers 201 with the ticket, the number masked, and never logs the ticket', async () => {
    const w = await world();
    const res = await create(w, w.owner, ticket(w));
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toMatchObject({
      itemId: w.itemPath,
      passenger: w.memberPath,
      seat: SEAT,
      ticketNo: { masked: true },
      baggage: { checkedKg: 23, cabinKg: null, addOns: [ADD_ON] },
      version: 1,
    });
    expect(res.body).not.toContain(TICKET_NO);
    logsNoTicket(res.headers['x-request-id']);
    const [row] = await tdb.db
      .selectFrom('tribo.tickets')
      .select('ticket_no_enc')
      .where('item_id', '=', w.itemId)
      .execute();
    expect(row?.ticket_no_enc?.toString('utf8')).not.toContain(TICKET_NO);
  });

  it('logs each refusal by operation and code, and never the ticket', async () => {
    const w = await world();
    const cases: [Caller, unknown, number, string][] = [
      [w.viewer, ticket(w), 403, 'forbidden'],
      [w.member, ticket(w), 403, 'forbidden'],
      [w.owner, ticket(w, { passenger: w.otherPath, ticketNo: '' }), 400, 'validation_failed'],
      [
        w.owner,
        ticket(w, { passenger: 'mem_01h455vb4pex5vsknk084sn02q' }),
        400,
        'validation_failed',
      ],
      [await signedInUser(), ticket(w), 404, 'not_found'],
    ];
    for (const [caller, body, status, problem] of cases) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const res = await create(w, caller, body);
      expect(res.statusCode, problem).toBe(status);
      expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
        operationId: 'tickets.create',
        problem,
      });
      logsNoTicket(res.headers['x-request-id']);
    }
    const duplicate = await create(w, w.owner, ticket(w));
    expect(duplicate.statusCode).toBe(201);
    const again = await create(w, w.owner, ticket(w));
    expect(again.statusCode).toBe(400);
    expect(refusalLine(again.headers['x-request-id'])).toMatchObject({
      problem: 'validation_failed',
    });
    logsNoTicket(again.headers['x-request-id']);
  });

  it('replays a repeat under the same Idempotency-Key, writing one ticket', async () => {
    const w = await world();
    const key = { 'idempotency-key': 'ferry-seat-12a' };
    const first = await create(w, w.owner, ticket(w), key);
    expect(first.statusCode).toBe(201);
    const again = await create(w, w.owner, ticket(w), key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(again.body).not.toContain(TICKET_NO);
    const rows = await tdb.db
      .selectFrom('tribo.tickets')
      .select('id')
      .where('item_id', '=', w.itemId)
      .execute();
    expect(rows).toHaveLength(1);
    logsNoTicket(again.headers['x-request-id']);

    // Another body under the same key is refused, and writes nothing.
    const other = await create(w, w.owner, ticket(w, { seat: 'Row 2' }), key);
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('checks access again on a replay: an organizer demoted since gets 403, not the stored answer', async () => {
    const w = await world();
    const key = { 'idempotency-key': 'before-demotion' };
    expect((await create(w, w.owner, ticket(w), key)).statusCode).toBe(201);
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ trip_role: 'viewer' })
      .where('id', '=', w.trip.ownerMembershipId)
      .execute();
    const replay = await create(w, w.owner, ticket(w), key);
    expect(replay.statusCode).toBe(403);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
    expect(replay.body).not.toContain(SEAT);
  });
});

describe('tickets.update over HTTP', () => {
  const patch = (
    caller: Caller,
    ticketPath: string,
    body: unknown,
    headers: Record<string, string> = { 'if-match': '"1"' },
  ) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/tickets/${ticketPath}`,
      payload: body as object,
      cookies: caller.auth.cookies,
      headers: { ...caller.auth.headers, ...headers },
    });

  it("reads If-Match, edits a member's own seat and baggage, and never logs the ticket", async () => {
    const w = await world();
    const ticketPath = encodeTypeId(ID_PREFIX.ticket, await memberTicket(w));
    const res = await patch(w.member, ticketPath, { seat: NEW_SEAT, baggage: { cabinKg: 6 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toMatchObject({
      id: ticketPath,
      passenger: w.memberPath,
      seat: NEW_SEAT,
      ticketNo: { masked: true },
      baggage: { checkedKg: 23, cabinKg: 6, addOns: [ADD_ON] },
      version: 2,
    });
    expect(res.body).not.toContain(TICKET_NO);
    logsNoTicket(res.headers['x-request-id']);
    // The organizer changes the number; the answer still holds only the mask.
    const renumbered = await patch(
      w.owner,
      ticketPath,
      { ticketNo: NEW_TICKET_NO },
      { 'if-match': '"2"' },
    );
    expect(renumbered.statusCode).toBe(200);
    expect(renumbered.body).not.toContain(NEW_TICKET_NO);
    logsNoTicket(renumbered.headers['x-request-id']);
  });

  it('logs each refusal by operation and code, and never the ticket', async () => {
    const w = await world();
    const ticketPath = encodeTypeId(ID_PREFIX.ticket, await memberTicket(w));
    const stranger = await signedInUser();
    const cases: [Caller, unknown, Record<string, string> | undefined, number, string][] = [
      [w.member, { ticketNo: NEW_TICKET_NO }, undefined, 409, 'masked_field_write'],
      [w.owner, { ticketNo: { masked: true } }, undefined, 409, 'masked_field_write'],
      [w.other, { seat: NEW_SEAT }, undefined, 403, 'forbidden'],
      [w.viewer, { seat: NEW_SEAT }, undefined, 403, 'forbidden'],
      [w.owner, { seat: NEW_SEAT }, {}, 428, 'if_match_required'],
      [w.owner, { seat: NEW_SEAT }, { 'if-match': '"9"' }, 412, 'version_conflict'],
      [w.owner, { seat: '' }, undefined, 400, 'validation_failed'],
      [stranger, { seat: NEW_SEAT }, undefined, 404, 'not_found'],
    ];
    for (const [caller, body, headers, status, problem] of cases) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const res = await patch(caller, ticketPath, body, headers);
      expect(res.statusCode, problem).toBe(status);
      expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
        operationId: 'tickets.update',
        problem,
      });
      logsNoTicket(res.headers['x-request-id']);
    }
    const malformed = await patch(w.owner, 'not-an-id', { seat: NEW_SEAT });
    expect(malformed.statusCode).toBe(404);
  });
});
