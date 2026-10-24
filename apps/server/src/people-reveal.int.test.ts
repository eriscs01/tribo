// library.people.reveal over HTTP: the person id named as the API names it, the plaintext
// emergency contact only in the answer, kept out of every cache, never replayed under an
// Idempotency-Key, and no line a request leaves holds the contact. The rules behind it are
// proven against the services in packages/testkit; here the boundaries are crossed for real
// (library, trips, audit, crypto).
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey, keyring } from '@tribo/crypto';
import {
  addMember,
  createTestDatabase,
  createTrip,
  createUser,
  sealEmergencyContact,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';
/** Words no other part of a log line could hold by chance. */
const CONTACT = { name: 'Rosalind Quiapo-Esteban', relation: 'sister', phone: '+63 917 555 8841' };

let tdb: TestDatabase;
let app: FastifyInstance;
const appKey = new AppKey(randomBytes(32));
const raw: string[] = [];
const linesOf = (requestId: unknown) =>
  raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  const services = composeServices(tdb.db, appKey, new URL('https://tribo.test'));
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    raw.push(...chunk.toString().split('\n').filter(Boolean));
  });
  app = await buildApp(services, { trustedProxies: ['loopback'], logLevel: 'debug', logStream });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedInUser() {
  n += 1;
  const username = `reveal_traveller_${String(n)}`;
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

/** An owner, an organizer, a member with an emergency contact and a viewer of one trip. */
async function world() {
  const owner = await signedInUser();
  const organizer = await signedInUser();
  const member = await signedInUser();
  const viewer = await signedInUser();
  const other = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  for (const [who, role] of [
    [organizer, 'organizer'],
    [member, 'member'],
    [viewer, 'viewer'],
    [other, 'member'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one membership each
    await addMember(tdb.db, { tripId: trip.tripId, personId: who.personId, role });
  }
  await sealEmergencyContact(tdb.db, keyring(appKey), member.personId, CONTACT);
  return { owner, organizer, member, viewer, other, trip };
}

const reveal = (
  caller: Caller,
  personId: string,
  body: unknown = { fields: ['emergencyContact'] },
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url: `/v1/library/people/${encodeTypeId(ID_PREFIX.person, personId)}/reveal`,
    payload: body as object,
    cookies: caller.auth.cookies,
    headers: { ...caller.auth.headers, ...headers },
  });

const eventsOf = (personId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select(['request_id', 'reason', 'actor_user_id', 'chain_key'])
    .where('entity_id', '=', personId)
    .where('action', '=', 'reveal')
    .orderBy('seq')
    .execute();

const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

/** No line the request logged holds any part of the emergency contact. */
function logsNoContact(requestId: unknown) {
  const mine = raw.filter((l) => l.includes(String(requestId)));
  expect(mine.length).toBeGreaterThan(0);
  for (const line of mine) {
    for (const secret of [CONTACT.name, 'Quiapo', CONTACT.phone, '8841']) {
      expect(line).not.toContain(secret);
    }
  }
}

describe('library.people.reveal over HTTP', () => {
  it('answers an organizer the plaintext contact, never cached, and logs none of it', async () => {
    const w = await world();
    const res = await reveal(w.organizer, w.member.personId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({ emergencyContact: CONTACT });
    const requestId = res.headers['x-request-id'];
    logsNoContact(requestId);
    expect(await eventsOf(w.member.personId)).toEqual([
      {
        request_id: requestId,
        reason: '/emergencyContact',
        actor_user_id: w.organizer.userId,
        chain_key: 'platform',
      },
    ]);
  });

  it('is never replayed: each call under the same Idempotency-Key is its own audited reveal', async () => {
    const w = await world();
    const key = { 'idempotency-key': 'reveal-person-twice' };
    const first = await reveal(w.member, w.member.personId, undefined, key);
    const second = await reveal(w.member, w.member.personId, undefined, key);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(await eventsOf(w.member.personId)).toHaveLength(2);
    const stored = await tdb.db
      .selectFrom('tribo.idempotency_keys')
      .selectAll()
      .where('key', '=', 'reveal-person-twice')
      .execute();
    expect(stored).toEqual([]);
  });

  it('refuses a plain member, a viewer and a stranger as for an unknown person, logs each by code, and writes no event', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const problem = (res: Awaited<ReturnType<typeof reveal>>) => {
      const { requestId: _r, instance: _i, ...rest } = res.json<Record<string, unknown>>();
      return [res.statusCode, rest];
    };
    const unknown = await reveal(w.owner, '0192f000-0000-7000-8000-00000000000c');
    expect(problem(unknown)).toEqual([404, expect.objectContaining({ code: 'not_found' })]);
    for (const caller of [w.other, w.viewer, stranger]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const res = await reveal(caller, w.member.personId);
      expect(problem(res)).toEqual(problem(unknown));
      expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
        operationId: 'library.people.reveal',
        problem: 'not_found',
        status: 404,
      });
      logsNoContact(res.headers['x-request-id']);
    }
    const bad = await reveal(w.owner, w.member.personId, { fields: ['passport'] });
    expect(bad.statusCode).toBe(400);
    expect(refusalLine(bad.headers['x-request-id'])).toMatchObject({
      operationId: 'library.people.reveal',
      problem: 'validation_failed',
    });
    expect(await eventsOf(w.member.personId)).toEqual([]);
  });

  it('answers 500 and logs the failure with its request id when the stored contact does not open, writing no event', async () => {
    const w = await world();
    await sealEmergencyContact(tdb.db, keyring(appKey), w.other.personId, CONTACT);
    const moved = await tdb.db
      .selectFrom('tribo.persons')
      .select('emergency_contact_enc')
      .where('id', '=', w.other.personId)
      .executeTakeFirstOrThrow();
    await tdb.db
      .updateTable('tribo.persons')
      .set({ emergency_contact_enc: moved.emergency_contact_enc })
      .where('id', '=', w.member.personId)
      .execute();
    const res = await reveal(w.owner, w.member.personId);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal_error' });
    const requestId = res.headers['x-request-id'];
    expect(linesOf(requestId).find((l) => l.msg === 'unhandled error')).toMatchObject({
      level: 50,
      operationId: 'library.people.reveal',
      err: { type: 'EnvelopeError' },
    });
    logsNoContact(requestId);
    expect(await eventsOf(w.member.personId)).toEqual([]);
  });
});
