// The account-security operations over HTTP: each handler is mounted, refuses callers its
// auth column does not admit, and answers its contract schema. Their rules are proven
// against the service in packages/testkit (auth-*.int.test.ts, me-*.int.test.ts).
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, MfaConfirm, MfaSetup, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createTripsService,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, createUser, totpFor, type TestDatabase } from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationHandlers } from './handlers/index.js';
import { buildServer } from './server.js';

const PASSWORD = 'correct horse battery';
const csrf = randomBytes(32);

let tdb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const identity = createIdentityService(
    tdb.db,
    keyring(new AppKey(randomBytes(32))),
    'Tribo (tribo.test)',
  );
  const write = writePath(tdb.db);
  app = await buildServer({
    trustedProxies: ['loopback'],
    csrfSecret: csrf,
    authenticate: (token) => identity.authenticate(token),
    handlers: operationHandlers({
      identity,
      csrfSecret: csrf,
      trips: createTripsService(tdb.db, write),
      items: createItemsService(tdb.db, write),
    }),
    ping: () => Promise.resolve(),
    logLevel: 'silent',
  });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedIn(password = PASSWORD) {
  n += 1;
  const username = `http_user_${String(n)}`;
  const { userId } = await createUser(tdb.db, { username, password });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    userId,
    username,
    cookies: { [SESSION_COOKIE]: token },
    headers: { [CSRF_HEADER]: csrfToken },
  };
}

describe('auth.mfa.setup over HTTP', () => {
  it('answers 201 with the pending secret for a signed-in caller', async () => {
    const caller = await signedIn();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp', ...caller });
    expect(res.statusCode).toBe(201);
    expect(MfaSetup.parse(res.json()).uri).toContain(caller.username);
  });

  it('refuses a caller without a session, and a session without its CSRF token', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp' });
    expect(anonymous.statusCode).toBe(401);
    const { cookies } = await signedIn();
    const forged = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp', cookies });
    expect(forged.statusCode).toBe(403);
  });
});

describe('auth.mfa.confirm over HTTP', () => {
  it('answers 201 with the recovery codes, and never replays them for an Idempotency-Key', async () => {
    const caller = await signedIn();
    const setup = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp', ...caller });
    const { key } = MfaSetup.parse(setup.json());
    const request = {
      method: 'POST' as const,
      url: '/v1/auth/mfa/totp/confirm',
      cookies: caller.cookies,
      headers: { ...caller.headers, 'idempotency-key': 'confirm-once' },
      payload: { code: totpFor(key) },
    };

    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(MfaConfirm.parse(first.json())).toMatchObject({ redacted: false });

    const repeat = await app.inject(request);
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json()).toMatchObject({ code: 'invalid_transition' });
    expect(repeat.body).not.toContain('recoveryCodes');
  });

  it('refuses a caller without a session, and a wrong code with validation_failed', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/confirm',
      payload: { code: '123456' },
    });
    expect(anonymous.statusCode).toBe(401);

    const caller = await signedIn();
    await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp', ...caller });
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/confirm',
      ...caller,
      payload: { code: 'abc' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });
  });
});
