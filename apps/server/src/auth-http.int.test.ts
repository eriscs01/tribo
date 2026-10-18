// The account-security operations over HTTP: each handler is mounted, refuses callers its
// auth column does not admit, and answers its contract schema. Their rules are proven
// against the service in packages/testkit (auth-*.int.test.ts, me-*.int.test.ts).
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, MfaSetup, SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createTripsService,
  writePath,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, createUser, type TestDatabase } from '@tribo/testkit';
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
