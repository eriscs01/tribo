// The in-app rate limits over HTTP (Technical design, Operations, "Rate limits"; decision
// 0008): writes without an account per client address, writes by an account per account,
// each refused with 429 rate_limited and Retry-After, through the real services.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import { createTestDatabase, createUser, type TestDatabase } from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';
const MINUTE = 60_000;

let tdb: TestDatabase;
let app: FastifyInstance;
/** The limiter's clock: tests move it instead of waiting. */
let now = 0;
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
  app = await buildApp(services, {
    trustedProxies: ['loopback'],
    logLevel: 'info',
    logStream,
    now: () => now,
  });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});
// Each test starts on a fresh window, a whole minute after the last one.
beforeEach(() => {
  now = (Math.floor(now / MINUTE) + 2) * MINUTE;
});

let n = 0;
async function account() {
  n += 1;
  const username = `limited_user_${String(n)}`;
  await createUser(tdb.db, { username, password: PASSWORD });
  return username;
}

/** A login as a direct client at `address`, or through Caddy (loopback) forwarding `forwardedFor`. */
const login = (username: string, from: { address?: string; forwardedFor?: string }) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    ...(from.address ? { remoteAddress: from.address } : {}),
    ...(from.forwardedFor ? { headers: { 'x-forwarded-for': from.forwardedFor } } : {}),
  });

async function loginTimes(times: number, from: { address?: string; forwardedFor?: string }) {
  const username = await account();
  const answers = await Promise.all(Array.from({ length: times }, () => login(username, from)));
  expect(answers.map((res) => res.statusCode)).toEqual(Array(times).fill(201));
  return username;
}

describe('logins per client address', () => {
  it('refuses the 11th login in a minute from one address with 429 and Retry-After', async () => {
    const username = await loginTimes(10, { address: '203.0.113.10' });
    now += 15_000;
    const res = await login(username, { address: '203.0.113.10' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(res.headers['retry-after']).toBe('45');
  });

  it('counts each address on its own', async () => {
    const username = await loginTimes(10, { address: '203.0.113.11' });
    expect((await login(username, { address: '203.0.113.11' })).statusCode).toBe(429);
    expect((await login(username, { address: '203.0.113.12' })).statusCode).toBe(201);
  });

  it('admits the address again once the window has passed', async () => {
    const username = await loginTimes(10, { address: '203.0.113.13' });
    expect((await login(username, { address: '203.0.113.13' })).statusCode).toBe(429);
    now += MINUTE;
    expect((await login(username, { address: '203.0.113.13' })).statusCode).toBe(201);
  });

  it('counts every IPv6 address of one /64 as one client', async () => {
    const username = await loginTimes(10, { address: '2001:db8:1:2::a' });
    const res = await login(username, { address: '2001:db8:1:2:ffff::b' });
    expect(res.statusCode).toBe(429);
    expect((await login(username, { address: '2001:db8:1:3::a' })).statusCode).toBe(201);
  });

  it('takes the client from X-Forwarded-For only when the peer is the trusted proxy', async () => {
    // Through Caddy (loopback): the forwarded client is counted, not the proxy.
    const username = await loginTimes(10, { forwardedFor: '198.51.100.20' });
    expect((await login(username, { forwardedFor: '198.51.100.20' })).statusCode).toBe(429);
    expect((await login(username, { forwardedFor: '198.51.100.21' })).statusCode).toBe(201);
  });

  it('ignores X-Forwarded-For from a peer that is not the trusted proxy', async () => {
    const username = await loginTimes(10, { address: '203.0.113.30' });
    // A direct client naming another address in the header is still counted as itself.
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username, password: PASSWORD },
      remoteAddress: '203.0.113.30',
      headers: { 'x-forwarded-for': '198.51.100.99' },
    });
    expect(forged.statusCode).toBe(429);
  });

  it('cannot be dodged by prepending addresses before the one the proxy forwards', async () => {
    const username = await loginTimes(10, { forwardedFor: '198.51.100.40' });
    // Caddy forwards one address; anything left of it came from the client and is ignored.
    const res = await login(username, { forwardedFor: '192.0.2.1, 198.51.100.40' });
    expect(res.statusCode).toBe(429);
  });

  it('counts the other writes made without an account, such as a password reset, in the same budget', async () => {
    const reset = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: {},
        remoteAddress: '203.0.113.40',
      });
    const refused = await Promise.all(Array.from({ length: 5 }, reset));
    expect(refused.map((res) => res.statusCode)).toEqual(Array(5).fill(400));
    const username = await account();
    const logins = await Promise.all(
      Array.from({ length: 5 }, () => login(username, { address: '203.0.113.40' })),
    );
    expect(logins.map((res) => res.statusCode)).toEqual(Array(5).fill(201));
    expect((await reset()).statusCode).toBe(429);
  });

  it('logs the refusal with the request id, operation and code, and no address or username', async () => {
    const username = await loginTimes(10, { address: '203.0.113.50' });
    const res = await login(username, { address: '203.0.113.50' });
    const requestId = res.headers['x-request-id'];
    const refused = linesOf(requestId).find((l) => l.msg === 'request refused');
    expect(refused).toMatchObject({
      operationId: 'auth.login',
      problem: 'rate_limited',
      status: 429,
    });
    const text = JSON.stringify(refused);
    expect(text).not.toContain('203.0.113.50');
    expect(text).not.toContain(username);
    expect(text).not.toContain(PASSWORD);
  });
});

describe('writes per account', () => {
  async function signedIn(address: string) {
    const username = await account();
    const res = await login(username, { address });
    expect(res.statusCode).toBe(201);
    const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
    const { csrfToken } = res.json<{ csrfToken: string }>();
    return { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } };
  }
  /** auth.mfa.setup: a write any signed-in account may repeat. */
  const write = (caller: Awaited<ReturnType<typeof signedIn>>) =>
    app.inject({ method: 'POST', url: '/v1/auth/mfa/totp', ...caller });

  it('refuses the 121st write in a minute from one account, and not another account', async () => {
    const first = await signedIn('203.0.113.60');
    const second = await signedIn('203.0.113.61');
    const admitted = await Promise.all(Array.from({ length: 120 }, () => write(first)));
    expect(admitted.map((res) => res.statusCode)).toEqual(Array(120).fill(201));
    now += 30_000;
    const refused = await write(first);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBe('30');
    expect((await write(second)).statusCode).toBe(201);
    expect(
      linesOf(refused.headers['x-request-id']).find((l) => l.msg === 'request refused'),
    ).toMatchObject({ operationId: 'auth.mfa.setup', problem: 'rate_limited' });
  });

  it('leaves reads unlimited', async () => {
    const caller = await signedIn('203.0.113.62');
    const reads = await Promise.all(
      Array.from({ length: 121 }, () => app.inject({ method: 'GET', url: '/v1/me', ...caller })),
    );
    expect(reads.map((res) => res.statusCode)).toEqual(Array(121).fill(200));
  });
});
