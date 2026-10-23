// The overlays handlers over HTTP: ids and times named as the API names them, the reply kept
// out of shared caches, preconditions read from the headers, and no line a request leaves
// holds a note, a checklist line or a reminder. The rules behind each operation are proven
// against the overlays service in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
  createItem,
  createOverlay,
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
const NOTE = 'Whisper the gate code to the ferryman';
const CHECK = 'Pack the heron-feather charm';
const REMINDER = '2031-02-03T04:05:06.000Z';

let tdb: TestDatabase;
let app: FastifyInstance;
const lines: Record<string, unknown>[] = [];
const raw: string[] = [];
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

/** A trip with a signed-in owner, member and viewer, and a shared item the owner holds. */
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
  const itemId = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    title: 'Ferry to Coco Grove',
  });
  return {
    owner,
    member,
    viewer,
    trip,
    memberMembershipId,
    itemId,
    itemPath: encodeTypeId(ID_PREFIX.item, itemId),
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
  };
}

type World = Awaited<ReturnType<typeof world>>;

const overlayUrl = (w: World) => `/v1/items/${w.itemPath}/overlay`;

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

/** No line the request logged holds the note, a checklist line or the reminder. */
function logsNoOverlay(requestId: unknown) {
  const mine = raw.filter((l) => l.includes(String(requestId)));
  expect(mine.length).toBeGreaterThan(0);
  for (const line of mine) {
    expect(line).not.toContain(NOTE);
    expect(line).not.toContain('ferryman');
    expect(line).not.toContain(CHECK);
    expect(line).not.toContain('heron');
    expect(line).not.toContain(REMINDER);
    expect(line).not.toContain('2031-02-03');
  }
}

describe('overlays.get over HTTP', () => {
  const get = (w: World, caller: Caller) =>
    app.inject({ method: 'GET', url: overlayUrl(w), cookies: caller.auth.cookies });

  it("answers 200 with the caller's overlay, its ids named as the API names them, kept from shared caches", async () => {
    const w = await world();
    await createOverlay(tdb.db, {
      tripId: w.trip.tripId,
      itemId: w.itemId,
      membershipId: w.memberMembershipId,
      note: NOTE,
      reminderAt: new Date(REMINDER),
      checklist: [{ text: CHECK, done: true }],
    });
    const res = await get(w, w.member);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toMatchObject({
      itemId: w.itemPath,
      tripId: w.tripPath,
      note: NOTE,
      reminderAt: REMINDER,
      checklist: [{ text: CHECK, done: true }],
      version: 1,
    });
    logsNoOverlay(res.headers['x-request-id']);
  });

  it('logs a refusal by operation and code, and answers a missing overlay and a viewer as the service does', async () => {
    const w = await world();
    const missing = await get(w, w.owner);
    expect(missing.statusCode).toBe(404);
    expect(refusalLine(missing.headers['x-request-id'])).toMatchObject({
      operationId: 'overlays.get',
      problem: 'not_found',
    });
    const viewer = await get(w, w.viewer);
    expect(viewer.statusCode).toBe(403);
    expect(refusalLine(viewer.headers['x-request-id'])).toMatchObject({
      operationId: 'overlays.get',
      problem: 'forbidden',
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/items/not-an-id/overlay',
      cookies: w.member.auth.cookies,
    });
    expect(malformed.statusCode).toBe(404);
  });
});

describe('overlays.put over HTTP', () => {
  const put = (w: World, caller: Caller, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: overlayUrl(w),
      payload: body as object,
      cookies: caller.auth.cookies,
      headers: { ...caller.auth.headers, ...headers },
    });
  const overlay = (overrides: Record<string, unknown> = {}) => ({
    note: NOTE,
    reminderAt: REMINDER,
    checklist: [{ text: CHECK, done: false }],
    ...overrides,
  });

  it('creates under If-None-Match: *, replaces under If-Match, and never logs the overlay', async () => {
    const w = await world();
    const created = await put(w, w.member, overlay(), { 'if-none-match': '*' });
    expect(created.statusCode).toBe(200);
    expect(created.headers['cache-control']).toBe('private, no-store');
    expect(created.json()).toMatchObject({
      itemId: w.itemPath,
      tripId: w.tripPath,
      note: NOTE,
      reminderAt: REMINDER,
      checklist: [{ text: CHECK, done: false }],
      version: 1,
    });
    logsNoOverlay(created.headers['x-request-id']);

    const replaced = await put(w, w.member, overlay({ note: null }), { 'if-match': '"1"' });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ note: null, version: 2 });
    logsNoOverlay(replaced.headers['x-request-id']);
  });

  it('answers the design’s precondition codes, each logged by operation and code, none with the overlay', async () => {
    const w = await world();
    const none = await put(w, w.member, overlay());
    expect(none.statusCode).toBe(428);
    expect(refusalLine(none.headers['x-request-id'])).toMatchObject({
      operationId: 'overlays.put',
      problem: 'if_match_required',
    });
    expect((await put(w, w.member, overlay(), { 'if-none-match': '*' })).statusCode).toBe(200);
    const again = await put(w, w.member, overlay(), { 'if-none-match': '*' });
    expect(again.statusCode).toBe(412);
    expect(refusalLine(again.headers['x-request-id'])).toMatchObject({
      operationId: 'overlays.put',
      problem: 'version_conflict',
    });
    const stale = await put(w, w.member, overlay(), { 'if-match': '"5"' });
    expect(stale.statusCode).toBe(412);
    // An entity tag in If-None-Match names nothing to create.
    const tagged = await put(w, w.member, overlay(), { 'if-none-match': '"1"' });
    expect(tagged.statusCode).toBe(428);
    for (const res of [none, again, stale, tagged]) {
      logsNoOverlay(res.headers['x-request-id']);
      expect(res.body).not.toContain(NOTE);
    }
  });

  it('refuses a viewer and a body that is not an overlay, logging neither the note nor the reminder', async () => {
    const w = await world();
    const viewer = await put(w, w.viewer, overlay(), { 'if-none-match': '*' });
    expect(viewer.statusCode).toBe(403);
    const invalid = await put(w, w.member, overlay({ reminderAt: '2031-02-03 soon' }), {
      'if-none-match': '*',
    });
    expect(invalid.statusCode).toBe(400);
    expect(refusalLine(invalid.headers['x-request-id'])).toMatchObject({
      operationId: 'overlays.put',
      problem: 'validation_failed',
    });
    for (const res of [viewer, invalid]) {
      logsNoOverlay(res.headers['x-request-id']);
      expect(res.body).not.toContain(NOTE);
    }
  });
});
