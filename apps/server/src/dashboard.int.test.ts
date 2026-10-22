// trips.dashboard over HTTP: the services answer, the view maps, the representation ETag
// answers a poll with 304, and every refusal leaves its log line. The rules behind it are
// proven against the services in packages/testkit; here the boundaries are crossed for real
// (trips, items, expenses).
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  CSRF_HEADER,
  encodeTypeId,
  ID_PREFIX,
  SESSION_COOKIE,
  type TripDashboard,
} from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addAllocation,
  addMember,
  createExpense,
  createItem,
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
  const username = `dashboard_traveller_${String(n)}`;
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

/** A signed-in owner, member and viewer of a trip a year out, with one priced item and one expense. */
async function world() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const viewer = await signedInUser();
  const year = new Date().getUTCFullYear() + 1;
  const trip = await createTrip(tdb.db, {
    owner,
    start: `${String(year)}-11-11`,
    end: `${String(year)}-11-14`,
  });
  const memberMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: member.personId,
    role: 'member',
  });
  await addMember(tdb.db, { tripId: trip.tripId, personId: viewer.personId, role: 'viewer' });
  const ferry = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'transport',
    title: 'Ferry to Siquijor',
    days: { start: `${String(year)}-11-11` },
    cost: { amountMinor: 80_000, currency: 'PHP' },
  });
  await createExpense(tdb.db, {
    tripId: trip.tripId,
    payerMembershipId: trip.ownerMembershipId,
    shares: [{ membershipId: memberMembershipId, amount: 40_000 }],
  });
  return {
    owner,
    member,
    memberMembershipId,
    viewer,
    trip,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
    ferry,
  };
}

const read = (w: { tripPath: string }, caller: Caller, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/v1/trips/${w.tripPath}/dashboard`,
    cookies: caller.auth.cookies,
    headers: { ...caller.auth.headers, ...headers },
  });

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

describe('trips.dashboard over HTTP', () => {
  it('answers the dashboard with type ids, my share and the next item', async () => {
    const w = await world();
    const res = await read(w, w.member);
    expect(res.statusCode).toBe(200);
    expect(res.json<TripDashboard>()).toMatchObject({
      tripId: w.tripPath,
      countdown: { phase: 'upcoming', timezone: 'Asia/Manila' },
      nextItem: { id: encodeTypeId(ID_PREFIX.item, w.ferry), cost: { amountMinor: 80_000 } },
      openTasks: [],
      dueSoon: [],
      myShare: { amountMinor: 40_000, currency: 'PHP' },
      warnings: [],
    });
  });

  it('lists a task of the caller’s due tomorrow as open and due soon', async () => {
    const w = await world();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const chore = await createItem(tdb.db, {
      tripId: w.trip.tripId,
      ownerMembershipId: w.trip.ownerMembershipId,
      type: 'task',
      title: 'Book the baggage add-on',
      days: { start: tomorrow },
    });
    await addAllocation(tdb.db, {
      tripId: w.trip.tripId,
      itemId: chore,
      membershipId: w.memberMembershipId,
      role: 'assignee',
    });
    const id = encodeTypeId(ID_PREFIX.item, chore);
    expect((await read(w, w.member)).json<TripDashboard>()).toMatchObject({
      openTasks: [{ id }],
      dueSoon: [{ kind: 'task_due', item: { id, title: 'Book the baggage add-on' } }],
    });
  });

  it('masks my share and costs for a viewer without the grant', async () => {
    const w = await world();
    const res = await read(w, w.viewer);
    expect(res.json<TripDashboard>()).toMatchObject({
      myShare: { masked: true },
      nextItem: { cost: { masked: true } },
    });
  });

  it('sends a representation ETag per caller, answers a matching poll with 304, and a change with 200', async () => {
    const w = await world();
    const first = await read(w, w.member);
    const tag = String(first.headers.etag);
    expect(tag).toMatch(/^"[\w-]{43}"$/);
    expect((await read(w, w.viewer)).headers.etag).not.toBe(tag);

    const unchanged = await read(w, w.member, { 'if-none-match': tag });
    expect([unchanged.statusCode, unchanged.body]).toEqual([304, '']);

    await createExpense(tdb.db, {
      tripId: w.trip.tripId,
      payerMembershipId: w.trip.ownerMembershipId,
      shares: [{ membershipId: w.trip.ownerMembershipId, amount: 1 }],
    });
    // Someone else's share changes nothing of the member's dashboard.
    expect((await read(w, w.member, { 'if-none-match': tag })).statusCode).toBe(304);
    await tdb.db
      .updateTable('tribo.items')
      .set({ title: 'Ferry to Larena' })
      .where('id', '=', w.ferry)
      .execute();
    const changed = await read(w, w.member, { 'if-none-match': tag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
  });

  it('refuses a trip the caller is not in with not_found and a log line of ids and codes only', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await read(w, stranger);
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([404, 'not_found']);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'trips.dashboard',
      problem: 'not_found',
      status: 404,
    });
    expect(JSON.stringify(linesOf(res.headers['x-request-id']))).not.toContain('Siquijor');
  });
});
