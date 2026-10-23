// Idempotency-Key over HTTP (Technical design, API design, "Idempotency"; decision 0017):
// a create that honours the header runs once per caller and key, and a repeat replays its
// stored response. The operation under test is expenses.create behind a test registry, with
// a handler that creates a library place through the real write path, so what is proven is
// the adapter and the write path, not the expenses story.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, registry, secret, SESSION_COOKIE, type Operation } from '@tribo/contract';
import { writePath } from '@tribo/core';
import { AppKey } from '@tribo/crypto';
import { ApiError, type WritePath } from '@tribo/platform';
import { createTestDatabase, createUser, type TestDatabase } from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { buildApp } from './app.js';
import { requestContext } from './context.js';
import type { Handlers } from './routes.js';
import { composeServices } from './runtime.js';

const PASSWORD = 'correct horse battery';

const TestInput = z.strictObject({
  name: z.string().min(1),
  /** Refuse after the write began, so nothing commits. */
  fail: z.boolean().optional(),
  /** Hold the transaction open, so a second request arrives while the first is in flight. */
  holdMs: z.int().max(2000).optional(),
});
const TestCreated = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** A shown-once value, as an invite token is: never stored for replay. */
  receipt: secret(z.string()).optional(),
  redacted: z.boolean(),
});

const base = registry.find((o) => o.id === 'expenses.create');
if (!base) throw new Error('expenses.create is not registered');
const testOp = {
  ...base,
  status: 'implemented',
  input: TestInput,
  output: TestCreated,
} as const satisfies Operation;
const testRegistry = registry.map((o) => (o.id === testOp.id ? testOp : o));

let tdb: TestDatabase;
let app: FastifyInstance;
let write: WritePath;
const lines: Record<string, unknown>[] = [];

/** Accounts the test operation refuses, as a trip refuses a member it has removed. */
const deniedUsers = new Set<string>();
/** Makes storing a response fail, as a dropped database connection would. */
let failStore = false;

const handlers: Handlers = {
  'expenses.create': async (request, reply) => {
    const place = await write(requestContext(request), {
      operation: testOp,
      target: { tripId: (request.params as { tripId: string }).tripId },
      body: request.body,
      ifMatch: undefined,
      authorize: (_tx, ctx) =>
        deniedUsers.has(ctx.userId ?? '')
          ? Promise.reject(new ApiError('not_found'))
          : Promise.resolve(),
      load: () => Promise.resolve({ tripId: null }),
      mutate: async (tx, ctx, _loaded, input) => {
        if (input.holdMs) await sql`SELECT pg_sleep(${input.holdMs / 1000})`.execute(tx);
        const row = await tx
          .insertInto('tribo.places')
          .values({
            name: input.name,
            kind: 'destination',
            created_by: ctx.userId,
            updated_by: ctx.userId,
          })
          .returning(['id', 'name'])
          .executeTakeFirstOrThrow();
        if (input.fail) throw new ApiError('capacity_exceeded');
        return {
          action: 'create',
          aggregate: 'place',
          entityId: row.id,
          tripId: null,
          version: 1,
          snapshot: { name: row.name },
          result: row,
        };
      },
    });
    return reply
      .code(201)
      .send({ id: place.id, name: place.name, receipt: 'shown-once', redacted: false });
  },
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  const composed = composeServices(
    tdb.db,
    new AppKey(randomBytes(32)),
    new URL('https://tribo.test'),
  );
  const services = {
    ...composed,
    idempotency: {
      ...composed.idempotency,
      storeResponse: (...args: Parameters<typeof composed.idempotency.storeResponse>) =>
        failStore
          ? Promise.reject(new Error('Connection terminated unexpectedly'))
          : composed.idempotency.storeResponse(...args),
    },
  };
  write = writePath(tdb.db);
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
    registry: testRegistry,
    handlers,
  });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
async function signedInUser() {
  n += 1;
  const username = `keyed_user_${String(n)}`;
  const { userId } = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress: `2001:db8:${n.toString(16)}::1`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return { userId, cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } };
}

type Auth = Awaited<ReturnType<typeof signedInUser>>;

let k = 0;
const newKey = () => {
  k += 1;
  return `key-${String(k)}-${randomBytes(4).toString('hex')}`;
};
const newName = () => `Place ${randomBytes(4).toString('hex')}`;

const create = (auth: Auth, payload: object, key?: string, url = '/v1/trips/trp_any/expenses') =>
  app.inject({
    method: 'POST',
    url,
    cookies: auth.cookies,
    headers: { ...auth.headers, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload,
  });

const placesNamed = async (name: string) =>
  (
    await tdb.db
      .selectFrom('tribo.places')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
  ).n;

const stored = (key: string) =>
  tdb.db.selectFrom('tribo.idempotency_keys').selectAll().where('key', '=', key).executeTakeFirst();

describe('Idempotency-Key on an operation that honours it', () => {
  it('runs the write once and replays the stored response with Idempotent-Replayed', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    const first = await create(auth, { name }, key);
    const again = await create(auth, { name }, key);

    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(await placesNamed(name)).toBe('1');
  });

  it('treats the same body with its keys in another order as the same request', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    await create(auth, { name, fail: false }, key);
    const again = await create(auth, { fail: false, name }, key);

    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await placesNamed(name)).toBe('1');
  });

  it('refuses the same key with a different body as 422 idempotency_key_reused', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();
    const other = newName();

    await create(auth, { name }, key);
    const reused = await create(auth, { name: other }, key);

    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(await placesNamed(other)).toBe('0');
    const refusal = lines.find(
      (l) => l.requestId === reused.headers['x-request-id'] && l.msg === 'request refused',
    );
    expect(refusal).toMatchObject({
      operationId: 'expenses.create',
      problem: 'idempotency_key_reused',
    });
    expect(JSON.stringify(refusal)).not.toContain(key);
  });

  it('refuses the same key on another path of the same operation', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    await create(auth, { name }, key, '/v1/trips/trp_one/expenses');
    const reused = await create(auth, { name }, key, '/v1/trips/trp_two/expenses');

    expect(reused.statusCode).toBe(422);
    expect(await placesNamed(name)).toBe('1');
  });

  it('scopes a key to its caller: another account with the same key gets its own write', async () => {
    const [ana, ben] = await Promise.all([signedInUser(), signedInUser()]);
    const key = newKey();
    const name = newName();

    const a = await create(ana, { name }, key);
    const b = await create(ben, { name }, key);

    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json<{ id: string }>().id).not.toBe(a.json<{ id: string }>().id);
    expect(await placesNamed(name)).toBe('2');
  });

  it('serialises concurrent requests with one key: one write, both answered alike', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    const [one, two] = await Promise.all([
      create(auth, { name, holdMs: 300 }, key),
      create(auth, { name, holdMs: 300 }, key),
    ]);

    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(one.json<{ id: string }>().id).toBe(two.json<{ id: string }>().id);
    expect([one, two].filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(1);
    expect(await placesNamed(name)).toBe('1');
  });

  it('stores nothing when the first request fails, so a retry with its key runs', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    const failed = await create(auth, { name, fail: true }, key);
    expect(failed.statusCode).toBe(409);
    expect(await stored(key)).toBeUndefined();

    const retried = await create(auth, { name }, key);
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(await placesNamed(name)).toBe('1');
  });

  it('keeps a response 24 hours, then lets the key run again', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    await create(auth, { name }, key);
    const row = await stored(key);
    expect(row).toBeDefined();
    const lifetime = (row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0);
    expect(lifetime).toBe(24 * 60 * 60 * 1000);

    await tdb.db
      .updateTable('tribo.idempotency_keys')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('key', '=', key)
      .execute();
    const after = await create(auth, { name }, key);

    expect(after.headers['idempotent-replayed']).toBeUndefined();
    expect(await placesNamed(name)).toBe('2');
  });

  it('never stores a shown-once field: a replay omits it and says redacted', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    const first = await create(auth, { name }, key);
    const again = await create(auth, { name }, key);

    expect(first.json()).toMatchObject({ receipt: 'shown-once', redacted: false });
    expect(again.json()).not.toHaveProperty('receipt');
    expect(again.json()).toMatchObject({ redacted: true });
    const row = await stored(key);
    expect(row?.response_redacted).toBe(true);
    expect(JSON.stringify(row?.response_body)).not.toContain('shown-once');
  });

  it('logs a replay with its operation and request id, never the key', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    await create(auth, { name }, key);
    const again = await create(auth, { name }, key);

    const replay = lines.find(
      (l) => l.requestId === again.headers['x-request-id'] && l.msg === 'idempotent replay',
    );
    expect(replay).toMatchObject({ operationId: 'expenses.create', status: 201 });
    expect(JSON.stringify(replay)).not.toContain(key);
  });

  it(
    'answers 500 and logs it when a committed claim never got its response stored',
    { timeout: 10_000 },
    async () => {
      const auth = await signedInUser();
      const key = newKey();
      const name = newName();
      await create(auth, { name }, key);
      // As after a crash between the write's commit and its reply.
      await tdb.db
        .updateTable('tribo.idempotency_keys')
        .set({ response_status: null, response_body: null })
        .where('key', '=', key)
        .execute();

      const again = await create(auth, { name }, key);

      expect(again.statusCode).toBe(500);
      expect(await placesNamed(name)).toBe('1');
      const failure = lines.find(
        (l) => l.requestId === again.headers['x-request-id'] && l.msg === 'unhandled error',
      );
      expect(failure).toMatchObject({ level: 50, operationId: 'expenses.create' });
      expect(JSON.stringify(failure)).toContain('no stored response');
      expect(JSON.stringify(failure)).not.toContain(key);
    },
  );

  it('answers the first request and logs it when its response cannot be stored', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();

    failStore = true;
    const first = await create(auth, { name }, key).finally(() => {
      failStore = false;
    });

    // The write committed, so its caller gets the answer it would have had.
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ name });
    const failure = lines.find(
      (l) =>
        l.requestId === first.headers['x-request-id'] && l.msg === 'idempotent response not stored',
    );
    expect(failure).toMatchObject({ level: 50, operationId: 'expenses.create' });
    expect(JSON.stringify(failure)).not.toContain(key);
  });

  it(
    'refuses a retry of a key whose response was never stored, without running it or hanging, until the key expires',
    { timeout: 10_000 },
    async () => {
      const auth = await signedInUser();
      const key = newKey();
      const name = newName();
      failStore = true;
      await create(auth, { name }, key).finally(() => {
        failStore = false;
      });

      const started = Date.now();
      const retry = await create(auth, { name }, key);

      expect(retry.statusCode).toBe(500);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await placesNamed(name)).toBe('1');

      await tdb.db
        .updateTable('tribo.idempotency_keys')
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where('key', '=', key)
        .execute();
      const afterExpiry = await create(auth, { name }, key);
      expect(afterExpiry.statusCode).toBe(201);
      expect(await placesNamed(name)).toBe('2');
    },
  );

  it('checks access again before a replay: a caller who lost it gets the refusal, not the stored body', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();
    await create(auth, { name }, key);

    deniedUsers.add(auth.userId);
    const again = await create(auth, { name }, key);

    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: 'not_found' });
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(await placesNamed(name)).toBe('1');
  });

  it('runs every request without a key', async () => {
    const auth = await signedInUser();
    const name = newName();

    await create(auth, { name });
    await create(auth, { name });

    expect(await placesNamed(name)).toBe('2');
  });

  it('refuses a key longer than 255 characters as validation_failed', async () => {
    const auth = await signedInUser();
    const res = await create(auth, { name: newName() }, 'k'.repeat(256));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });
});

describe('Idempotency-Key on an operation that does not honour it', () => {
  it('is ignored: each request runs', async () => {
    const auth = await signedInUser();
    const key = newKey();
    const name = newName();
    const place = () =>
      app.inject({
        method: 'POST',
        url: '/v1/library/places',
        cookies: auth.cookies,
        headers: { ...auth.headers, 'idempotency-key': key },
        payload: { name, kind: 'destination' },
      });

    const [one, two] = [await place(), await place()];

    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(two.headers['idempotent-replayed']).toBeUndefined();
    expect(await placesNamed(name)).toBe('2');
    expect(await stored(key)).toBeUndefined();
  });
});
