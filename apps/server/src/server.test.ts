import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { defineOperation, registry, SESSION_COOKIE, type Operation } from '@tribo/contract';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { ApiError } from './errors.js';
import { buildServer, type ServerDeps } from './server.js';
import { csrfTokenFor, setSessionCookie } from './session.js';

const secret = randomBytes(32);
const base = registry.find((op) => op.id === 'meta.liveness');
if (!base) throw new Error('meta.liveness missing');

const testOp = (id: string, method: Operation['method'], path: string, auth: Operation['auth']) =>
  defineOperation({ ...base, id, method, path, auth, status: 'implemented', output: z.unknown() });

const testRegistry: Operation[] = [
  ...registry,
  testOp('test.ip', 'GET', '/v1/test/ip', ['public']),
  testOp('test.boom', 'GET', '/v1/test/boom', ['public']),
  testOp('test.conflict', 'GET', '/v1/test/conflict', ['public']),
  testOp('test.login', 'POST', '/v1/test/login', ['public']),
  testOp('test.write', 'POST', '/v1/test/write', ['session', 'pat:write']),
];

let app: FastifyInstance | undefined;
let lines: Record<string, unknown>[] = [];

async function server(overrides: Partial<ServerDeps> = {}) {
  lines = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  app = await buildServer({
    trustedProxies: ['loopback', 'uniquelocal'],
    csrfSecret: secret,
    ping: () => Promise.resolve(),
    logStream: stream,
    registry: testRegistry,
    handlers: {
      'test.ip': (request) => {
        request.log.info('handler ran');
        return Promise.resolve({ ip: request.ip });
      },
      'test.boom': () => Promise.reject(new Error('db password is hunter2')),
      'test.conflict': () => Promise.reject(new ApiError('version_conflict')),
      'test.login': (_request, reply) => {
        setSessionCookie(reply, 'session-token', 3600);
        return Promise.resolve({ ok: true });
      },
      'test.write': () => Promise.resolve({ ok: true }),
    },
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('answers 200 with no details when the database is reachable', async () => {
    const res = await (await server()).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 with an empty body when it is not', async () => {
    const s = await server({ ping: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5')) });
    const res = await s.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('');
  });
});

describe('problem details', () => {
  it('answers a planned operation with 501 not_implemented', async () => {
    const res = await (await server()).inject({ method: 'GET', url: '/v1/trips' });
    expect(res.statusCode).toBe(501);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({
      code: 'not_implemented',
      status: 501,
      instance: '/v1/trips',
    });
  });

  it('answers an unknown route with 404 not_found', async () => {
    const res = await (await server()).inject({ method: 'GET', url: '/v1/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found', instance: '/v1/nope' });
  });

  it('maps an ApiError to its code and status', async () => {
    const res = await (await server()).inject({ method: 'GET', url: '/v1/test/conflict' });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({
      code: 'version_conflict',
      type: 'urn:tribo:problem:version_conflict',
    });
  });

  it('hides unexpected errors: 500 internal_error with no message or stack', async () => {
    const res = await (await server()).inject({ method: 'GET', url: '/v1/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal_error' });
    expect(res.body).not.toMatch(/hunter2|Error:|at /);
  });

  it('answers malformed JSON with 400 validation_failed', async () => {
    const res = await (
      await server()
    ).inject({
      method: 'POST',
      url: '/v1/test/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"oops"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });
});

describe('request id', () => {
  it('is minted, returned in the header and the problem body, and on every request log line', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/v1/test/ip' });
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const requestLines = lines.filter((l) => 'req' in l || 'res' in l || l.msg === 'handler ran');
    expect(requestLines.length).toBeGreaterThanOrEqual(3);
    for (const line of requestLines) expect(line.requestId).toBe(id);

    const problemRes = await s.inject({ method: 'GET', url: '/v1/trips' });
    expect(problemRes.json()).toMatchObject({ requestId: problemRes.headers['x-request-id'] });
  });

  it("keeps Caddy's X-Request-Id only from a trusted proxy", async () => {
    const s = await server();
    const fromCaddy = await s.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '172.18.0.3',
      headers: { 'x-request-id': '7f0c2a9e-caddy-request' },
    });
    expect(fromCaddy.headers['x-request-id']).toBe('7f0c2a9e-caddy-request');

    const fromInternet = await s.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '203.0.113.9',
      headers: { 'x-request-id': '7f0c2a9e-spoofed-id' },
    });
    expect(fromInternet.headers['x-request-id']).not.toBe('7f0c2a9e-spoofed-id');

    const malformed = await s.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '172.18.0.3',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('client IP', () => {
  it('reads X-Forwarded-For only from trusted proxies', async () => {
    const s = await server();
    const viaCaddy = await s.inject({
      method: 'GET',
      url: '/v1/test/ip',
      remoteAddress: '172.18.0.3',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(viaCaddy.json()).toEqual({ ip: '198.51.100.7' });

    const direct = await s.inject({
      method: 'GET',
      url: '/v1/test/ip',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(direct.json()).toEqual({ ip: '203.0.113.9' });
  });
});

describe('session cookie and CSRF', () => {
  it('sets the session as a __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain', async () => {
    const res = await (await server()).inject({ method: 'POST', url: '/v1/test/login' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=session-token`));
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('refuses an unsafe session request without a valid CSRF header', async () => {
    const s = await server();
    const cookies = { [SESSION_COOKIE]: 'session-token' };
    const missing = await s.inject({ method: 'POST', url: '/v1/test/write', cookies });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'forbidden' });

    const wrong = await s.inject({
      method: 'POST',
      url: '/v1/test/write',
      cookies,
      headers: { 'x-csrf-token': csrfTokenFor(secret, 'another-session') },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await s.inject({
      method: 'POST',
      url: '/v1/test/write',
      cookies,
      headers: { 'x-csrf-token': csrfTokenFor(secret, 'session-token') },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('leaves requests without a session cookie to authentication', async () => {
    const res = await (await server()).inject({ method: 'POST', url: '/v1/test/write' });
    expect(res.statusCode).toBe(200);
  });

  it('checks CSRF on planned session routes too, before the 501', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { [SESSION_COOKIE]: 'session-token' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('registry coverage at start', () => {
  it('refuses a handler for an operation that is not implemented', async () => {
    await expect(server({ handlers: { 'trips.list': () => Promise.resolve([]) } })).rejects.toThrow(
      /trips.list has no implemented registry operation/,
    );
  });

  it('refuses an implemented operation without a handler', async () => {
    await expect(
      server({
        handlers: {},

        registry: [...registry, testOp('test.orphan', 'GET', '/v1/test/orphan', ['public'])],
      }),
    ).rejects.toThrow(/test.orphan has no handler/);
  });
});

describe('logging', () => {
  it('redacts secrets in logged objects', async () => {
    const s = await server();
    s.log.info({ password: 'hunter2', body: { totpCode: '123456', token: 'abc' } }, 'redaction');
    const line = JSON.stringify(lines.find((l) => l.msg === 'redaction'));
    expect(line).not.toMatch(/hunter2|123456|"abc"/);
    expect(line).toContain('[Redacted]');
  });
});

describe('config', () => {
  async function secrets() {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-secrets-'));
    await writeFile(join(dir, 'db_app_password'), 'app-pw\n');
    await writeFile(join(dir, 'db_owner_password'), 'owner-pw\n');
    return dir;
  }

  it('parses the environment and reads secrets from files', async () => {
    const dir = await secrets();
    const config = loadConfig({
      TRIBO_PUBLIC_URL: 'https://tribo.example.org',
      TRIBO_SECRETS_DIR: dir,
    });
    expect(config.publicUrl.origin).toBe('https://tribo.example.org');
    expect(config.db).toMatchObject({ host: 'db', port: 5432, appPassword: 'app-pw' });
    expect(config.trustedProxies).toEqual(['loopback', 'uniquelocal']);
  });

  it('fails with the variable name, never its value', () => {
    const run = () =>
      loadConfig({ TRIBO_PUBLIC_URL: 'http://secret-host.example', TRIBO_PORT: 'abc' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/TRIBO_PUBLIC_URL/);
    expect(run).toThrow(/TRIBO_PORT/);
    expect(run).not.toThrow(/secret-host|abc/);
  });

  it('names a missing secret file, not its content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-secrets-'));
    await writeFile(join(dir, 'db_app_password'), 'app-pw');
    expect(() =>
      loadConfig({ TRIBO_PUBLIC_URL: 'https://t.example.org', TRIBO_SECRETS_DIR: dir }),
    ).toThrow(/db_owner_password .*ENOENT/);
  });
});
