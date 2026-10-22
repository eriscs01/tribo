// The invites handlers over HTTP, through composeServices and buildApp: requests parse,
// services answer, views map, refusals log, and no token reaches a log line or an audit
// row. The rules behind each operation are proven against the service in packages/testkit.
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
const raw: string[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://tribo.test'));
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    raw.push(chunk.toString());
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
/** A client address of its own, so many sign-ins and joins stay under the per-address limit. */
const address = () => {
  n += 1;
  return `2001:db8:${n.toString(16)}::1`;
};

/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedInUser() {
  const username = `invite_traveller_${String(n + 1)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD, mfa: false });
  const remoteAddress = address();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    ...user,
    username,
    remoteAddress,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

/** A signed-in owner and viewer in one trip, with a placeholder traveller. */
async function world() {
  const owner = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner, name: 'Siargao surf week' });
  const viewerMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: viewer.personId,
    role: 'viewer',
  });
  const guestId = await createPlaceholder(tdb.db, {
    createdBy: owner.userId,
    displayName: 'Tito Boy',
  });
  const guestMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: guestId,
    role: 'member',
  });
  const tripTid = encodeTypeId(ID_PREFIX.trip, trip.tripId);
  return {
    owner,
    viewer,
    trip,
    guestId,
    viewerMembershipId,
    guestMembershipId,
    invitesUrl: `/v1/trips/${tripTid}/invites`,
  };
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

/** The owner creates an invite over HTTP; returns its view, token and link included. */
async function createInvite(w: Awaited<ReturnType<typeof world>>, payload: object) {
  const res = await app.inject({
    method: 'POST',
    url: w.invitesUrl,
    payload: { expiresAt: tomorrow(), ...payload },
    ...w.owner.auth,
  });
  expect(res.statusCode).toBe(201);
  return {
    res,
    body: res.json<{ id: string; token: string; link: string; [k: string]: unknown }>(),
  };
}

/** Every audit row the request wrote, as stored. */
const auditRows = (requestId: unknown) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('request_id', '=', String(requestId))
    .execute();

describe('invites.create over HTTP', () => {
  it('answers 201 with the link shown once, and logs and audits it without the token', async () => {
    const w = await world();
    const { res, body } = await createInvite(w, { role: 'member', maxUses: 3 });
    expect(body).toMatchObject({
      tripId: encodeTypeId(ID_PREFIX.trip, w.trip.tripId),
      role: 'member',
      personId: null,
      maxUses: 3,
      uses: 0,
      status: 'active',
      revokedAt: null,
      redacted: false,
    });
    expect(body.id).toMatch(/^inv_/);
    expect(body.link).toBe(`https://tribo.test/join#${body.token}`);
    const requestId = res.headers['x-request-id'];
    expect(linesOf(requestId).length).toBeGreaterThan(0);
    expect(raw.join('')).not.toContain(body.token);
    const audit = await auditRows(requestId);
    expect(audit.map((r) => [r.action, r.entity_type])).toEqual([['create', 'invite']]);
    expect(JSON.stringify(audit)).not.toContain(body.token);
  });

  it('answers a viewer 403 forbidden and logs the refusal with its request id and operation', async () => {
    const w = await world();
    const res = await app.inject({
      method: 'POST',
      url: w.invitesUrl,
      payload: { role: 'member', expiresAt: tomorrow() },
      ...w.viewer.auth,
    });
    expect(res.statusCode).toBe(403);
    const refused = linesOf(res.headers['x-request-id']).find((l) => l.msg === 'request refused');
    expect(refused).toMatchObject({
      level: 30,
      operationId: 'invites.create',
      problem: 'forbidden',
      status: 403,
    });
  });

  it('answers 410 invite_invalid for a person who is no placeholder member, and logs it', async () => {
    const w = await world();
    const res = await app.inject({
      method: 'POST',
      url: w.invitesUrl,
      payload: {
        personId: encodeTypeId(ID_PREFIX.person, w.viewer.personId),
        expiresAt: tomorrow(),
      },
      ...w.owner.auth,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'invite_invalid' });
    const refused = linesOf(res.headers['x-request-id']).find((l) => l.msg === 'request refused');
    expect(refused).toMatchObject({ operationId: 'invites.create', problem: 'invite_invalid' });
  });
});

describe('invites.list over HTTP', () => {
  it('answers the owner a page of invites without any token or link', async () => {
    const w = await world();
    const { body: created } = await createInvite(w, { role: 'viewer' });
    const res = await app.inject({ method: 'GET', url: w.invitesUrl, ...w.owner.auth });
    expect(res.statusCode).toBe(200);
    const page = res.json<{ items: Record<string, unknown>[]; nextCursor: string | null }>();
    expect(page.items).toEqual([expect.objectContaining({ id: created.id, status: 'active' })]);
    expect(Object.keys(page.items[0] ?? {})).not.toContain('token');
    expect(res.body).not.toContain(created.token);
  });
});
