// trips.offlineBundle over HTTP: the services answer, the views map every part, the
// representation ETag is the SHA-256 of the body sent and answers a poll with 304, no cache
// may keep it, nothing sealed is in it, and every refusal leaves its log line. The rules
// behind it are proven against the services in packages/testkit; here the boundaries are
// crossed for real (trips, items, expenses, documents, library, crypto).
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  CSRF_HEADER,
  encodeTypeId,
  ID_PREFIX,
  SESSION_COOKIE,
  TripOfflineBundle,
} from '@tribo/contract';
import { AppKey, keyring } from '@tribo/crypto';
import {
  addMember,
  createExpense,
  createFile,
  createItem,
  createOverlay,
  createTestDatabase,
  createTicket,
  createTrip,
  createUser,
  sealBookingRef,
  sealEmergencyContact,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';
const MARKERS = ['BUNDLE-REF-7731', 'BUNDLE-TKT-0042', 'BUNDLE-SOS-Rosa', 'bundle-note-owner'];

let tdb: TestDatabase;
let app: FastifyInstance;
const appKey = new AppKey(randomBytes(32));
const keys = keyring(appKey);
const lines: Record<string, unknown>[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  const services = composeServices(tdb.db, appKey, new URL('https://tribo.test'));
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
  const username = `bundle_traveller_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
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

/** An owner, a member and a viewer of one trip, with a sealed value of every kind in it. */
async function world() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner, name: 'Siquijor' });
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
    days: { start: '2026-11-11' },
    cost: { amountMinor: 80_000, currency: 'PHP' },
  });
  await sealBookingRef(tdb.db, keys, ferry, MARKERS[0] ?? '');
  await createTicket(tdb.db, keys, {
    tripId: trip.tripId,
    itemId: ferry,
    membershipId: memberMembershipId,
    seat: '12A',
    ticketNo: MARKERS[1] ?? '',
  });
  await sealEmergencyContact(tdb.db, keys, member.personId, {
    name: MARKERS[2] ?? '',
    phone: '+63 917 555 0100',
  });
  await createOverlay(tdb.db, {
    tripId: trip.tripId,
    itemId: ferry,
    membershipId: trip.ownerMembershipId,
    note: MARKERS[3] ?? '',
  });
  await createExpense(tdb.db, {
    tripId: trip.tripId,
    payerMembershipId: trip.ownerMembershipId,
    shares: [{ membershipId: memberMembershipId, amount: 40_000 }],
    itemId: ferry,
  });
  await createFile(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    itemId: ferry,
    kind: 'ticket',
  });
  return {
    owner,
    member,
    viewer,
    trip,
    ferry,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
  };
}

const read = (tripPath: string, caller: Caller, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/v1/trips/${tripPath}/offline-bundle`,
    cookies: caller.auth.cookies,
    headers: { ...caller.auth.headers, ...headers },
  });

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

describe('trips.offlineBundle over HTTP', () => {
  it('answers the bundle in the contract’s shape, with type ids, and forbids every cache to keep it', async () => {
    const w = await world();
    const res = await read(w.tripPath, w.member);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const bundle = TripOfflineBundle.parse(res.json());
    const ferry = encodeTypeId(ID_PREFIX.item, w.ferry);
    expect(bundle).toMatchObject({
      trip: { id: w.tripPath, name: 'Siquijor' },
      items: [{ id: ferry, bookingRef: { masked: true }, cost: { amountMinor: 80_000 } }],
      tickets: [{ itemId: ferry, seat: '12A', ticketNo: { masked: true } }],
      overlays: [],
      expenses: [{ itemId: ferry, amount: { amountMinor: 40_000 } }],
      files: [{ itemId: ferry, kind: 'ticket' }],
      truncated: false,
    });
    expect(bundle.members.map((m) => m.person.emergencyContact)).toContainEqual({ masked: true });
    expect(bundle.itinerary.group.days[0]?.entries[0]?.itemId).toBe(ferry);
  });

  it('shows the owner their own overlay, and costs masked to a viewer', async () => {
    const w = await world();
    const owner = TripOfflineBundle.parse((await read(w.tripPath, w.owner)).json());
    expect(owner.overlays).toMatchObject([{ note: MARKERS[3] }]);
    expect(owner.tickets).toEqual([]);
    const viewer = TripOfflineBundle.parse((await read(w.tripPath, w.viewer)).json());
    expect(viewer.items[0]?.cost).toEqual({ masked: true });
    expect(viewer.expenses[0]?.amount).toEqual({ masked: true });
  });

  it('holds no sealed value in any role’s body, headers or log lines', async () => {
    const w = await world();
    for (const caller of [w.owner, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const res = await read(w.tripPath, caller);
      const sent = JSON.stringify(res.headers) + res.body;
      const logged = JSON.stringify(linesOf(res.headers['x-request-id']));
      for (const marker of MARKERS.slice(0, 3)) {
        expect(sent).not.toContain(marker);
        expect(logged).not.toContain(marker);
      }
      expect(logged).not.toContain(MARKERS[3]);
    }
  });

  it('tags the bundle with the SHA-256 of the body sent, per caller, and answers an unchanged poll with 304', async () => {
    const w = await world();
    const first = await read(w.tripPath, w.member);
    const tag = String(first.headers.etag);
    expect(tag).toBe(`"${createHash('sha256').update(first.body).digest('base64url')}"`);
    expect((await read(w.tripPath, w.viewer)).headers.etag).not.toBe(tag);
    expect((await read(w.tripPath, w.member)).headers.etag).toBe(tag);

    const unchanged = await read(w.tripPath, w.member, { 'if-none-match': tag });
    expect([unchanged.statusCode, unchanged.body]).toEqual([304, '']);
    expect(unchanged.headers['cache-control']).toBe('private, no-store');

    // Another member's private overlay changes nothing of the member's bundle.
    await createOverlay(tdb.db, {
      tripId: w.trip.tripId,
      itemId: await createItem(tdb.db, {
        tripId: w.trip.tripId,
        ownerMembershipId: w.trip.ownerMembershipId,
        visibility: 'private',
      }),
      membershipId: w.trip.ownerMembershipId,
      note: 'another secret',
    });
    expect((await read(w.tripPath, w.member, { 'if-none-match': tag })).statusCode).toBe(304);

    await tdb.db
      .updateTable('tribo.items')
      .set({ title: 'Ferry to Larena' })
      .where('id', '=', w.ferry)
      .execute();
    const changed = await read(w.tripPath, w.member, { 'if-none-match': tag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
  });

  it('refuses a trip the caller is not in as one that does not exist, with a log line of ids and codes only', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await read(w.tripPath, stranger);
    const unknown = await read(
      encodeTypeId(ID_PREFIX.trip, '00000000-0000-7000-8000-000000000001'),
      stranger,
    );
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([404, 'not_found']);
    const answer = (r: typeof res) => {
      const { requestId: _r, instance: _i, ...problem } = r.json<Record<string, unknown>>();
      return [r.statusCode, problem];
    };
    expect(answer(unknown)).toEqual(answer(res));
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'trips.offlineBundle',
      problem: 'not_found',
      status: 404,
    });
    expect(JSON.stringify(linesOf(res.headers['x-request-id']))).not.toContain('Siquijor');
  });
});
