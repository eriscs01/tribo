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
import { csrfSecret, csrfTokenFor } from './session.js';

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

describe('invites.revoke over HTTP', () => {
  it('answers 200 with the revoked invite, and a viewer 403 with its refusal logged', async () => {
    const w = await world();
    const { body: created } = await createInvite(w, { role: 'member' });
    const url = `${w.invitesUrl}/${created.id}/revoke`;
    const refused = await app.inject({ method: 'POST', url, ...w.viewer.auth });
    expect(refused.statusCode).toBe(403);
    expect(
      linesOf(refused.headers['x-request-id']).find((l) => l.msg === 'request refused'),
    ).toMatchObject({ operationId: 'invites.revoke', problem: 'forbidden' });
    const res = await app.inject({ method: 'POST', url, ...w.owner.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: created.id, status: 'revoked' });
  });
});

/** A public request from a fresh client address, as a new joiner's browser sends it. */
const anonymous = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload, remoteAddress: address() });

/** A problem body without the parts that name the request. */
const problemShape = (body: Record<string, unknown>) => {
  const { requestId: _requestId, ...rest } = body;
  return rest;
};

describe('invites.preview over HTTP', () => {
  it('answers anyone holding the link, with no session, from a token in the body', async () => {
    const w = await world();
    const { body: created } = await createInvite(w, {
      personId: encodeTypeId(ID_PREFIX.person, w.guestId),
    });
    const res = await anonymous('/v1/invites/preview', { token: created.token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tripName: 'Siargao surf week',
      role: 'member',
      placeholderName: 'Tito Boy',
    });
    expect(raw.join('')).not.toContain(created.token);
  });

  it('answers every dead link the same 410 invite_invalid, logged without the token', async () => {
    const w = await world();
    const { body: revoked } = await createInvite(w, { role: 'member' });
    await app.inject({
      method: 'POST',
      url: `${w.invitesUrl}/${revoked.id}/revoke`,
      ...w.owner.auth,
    });
    const unknown = await anonymous('/v1/invites/preview', { token: 'b'.repeat(43) });
    const dead = await anonymous('/v1/invites/preview', { token: revoked.token });
    for (const res of [unknown, dead]) {
      expect(res.statusCode).toBe(410);
      expect(
        linesOf(res.headers['x-request-id']).find((l) => l.msg === 'request refused'),
      ).toMatchObject({ operationId: 'invites.preview', problem: 'invite_invalid', status: 410 });
    }
    expect(problemShape(dead.json())).toEqual(problemShape(unknown.json()));
    expect(raw.join('')).not.toContain(revoked.token);
  });
});

describe('invites.accept over HTTP', () => {
  it('signs a new account in with the session cookie, and logs neither token nor password', async () => {
    const w = await world();
    const { body: invite } = await createInvite(w, { role: 'member' });
    const res = await anonymous('/v1/invites/accept', {
      token: invite.token,
      account: { username: 'new_joiner_http', password: PASSWORD, displayName: 'Kuya Ben' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      member: { id: string; role: string };
      session: { csrfToken: string };
    }>();
    expect(body.member).toMatchObject({ role: 'member', person: { displayName: 'Kuya Ben' } });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    // The cookie it set is a live session in the trip it joined.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/trips/${encodeTypeId(ID_PREFIX.trip, w.trip.tripId)}/members`,
      cookies: { [SESSION_COOKIE]: cookie?.value ?? '' },
    });
    expect(members.statusCode).toBe(200);
    const logs = raw.join('');
    for (const secret of [invite.token, PASSWORD, cookie?.value ?? '']) {
      expect(logs).not.toContain(secret);
    }
    const audit = await auditRows(res.headers['x-request-id']);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(invite.token);
  });

  it('joins the signed-in caller with the token alone, under their CSRF token', async () => {
    const w = await world();
    const joiner = await signedInUser();
    const { body: invite } = await createInvite(w, { role: 'viewer' });
    const withoutCsrf = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      payload: { token: invite.token },
      cookies: joiner.auth.cookies,
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      payload: { token: invite.token },
      ...joiner.auth,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      member: { role: 'viewer', person: { id: encodeTypeId(ID_PREFIX.person, joiner.personId) } },
      session: null,
    });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a dead session cookie as nobody: a new account still joins', async () => {
    const w = await world();
    const { body: invite } = await createInvite(w, { role: 'member' });
    const stale = 'not-a-live-session';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      payload: {
        token: invite.token,
        account: { username: 'stale_cookie_joiner', password: PASSWORD },
      },
      cookies: { [SESSION_COOKIE]: stale },
      // CSRF holds for any request that carries a cookie, live or not.
      headers: { [CSRF_HEADER]: csrfTokenFor(csrfSecret(services.appKey), stale) },
      remoteAddress: address(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      member: { role: 'member' },
      session: { mfaVerified: false },
    });
  });

  it('answers a dead link 410 invite_invalid, logged with its request id and operation', async () => {
    const res = await anonymous('/v1/invites/accept', {
      token: 'd'.repeat(43),
      account: { username: 'nobody_joins', password: PASSWORD },
    });
    expect(res.statusCode).toBe(410);
    expect(
      linesOf(res.headers['x-request-id']).find((l) => l.msg === 'request refused'),
    ).toMatchObject({ operationId: 'invites.accept', problem: 'invite_invalid', status: 410 });
  });
});
