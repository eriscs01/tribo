// The expenses handlers over HTTP: bodies parse, views name ids as the API does, the
// Idempotency-Key replays expenses.create, and no log line a request leaves holds an
// amount or a description. The rules behind each operation are proven against the
// expenses service in packages/testkit.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
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
/** Amounts and words no other part of a log line could hold by chance. */
const AMOUNT = 987_654_321;
const DESCRIPTION = 'Lantern dinner at Coco Grove';

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
  const username = `ledger_keeper_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress: `2001:db8:e${n.toString(16)}::1`,
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

/** A signed-in owner, member and viewer of a PHP trip. */
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
  const viewerMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: viewer.personId,
    role: 'viewer',
  });
  return {
    owner,
    member,
    viewer,
    trip,
    memberMembershipId,
    viewerMembershipId,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
    mem: (id: string) => encodeTypeId(ID_PREFIX.membership, id),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** The lantern dinner the member paid, split equally among owner, member and viewer. */
const dinner = (w: World, overrides: Record<string, unknown> = {}) => ({
  category: 'food',
  description: DESCRIPTION,
  spentOn: '2026-11-12',
  payerMembershipId: w.mem(w.memberMembershipId),
  amount: { amountMinor: AMOUNT, currency: 'PHP' },
  split: {
    method: 'equal',
    membershipIds: [w.trip.ownerMembershipId, w.memberMembershipId, w.viewerMembershipId].map(
      w.mem,
    ),
  },
  ...overrides,
});

const create = (w: World, caller: Caller, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/v1/trips/${w.tripPath}/expenses`,
    payload: body as object,
    cookies: caller.auth.cookies,
    headers: { ...caller.auth.headers, ...headers },
  });

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

/** No line the request logged holds the description, the amount or any share of it. */
function logsNoMoney(requestId: unknown) {
  const mine = raw.filter((l) => l.includes(String(requestId)));
  expect(mine.length).toBeGreaterThan(0);
  for (const line of mine) {
    expect(line).not.toContain(DESCRIPTION);
    expect(line).not.toContain('Lantern');
    expect(line).not.toContain(String(AMOUNT));
    expect(line).not.toContain(String(Math.floor(AMOUNT / 3)));
  }
}

describe('expenses.create over HTTP', () => {
  it('answers 201 with the expense, its ids named as the API names them', async () => {
    const w = await world();
    const res = await create(w, w.member, dinner(w));
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      tripId: w.tripPath,
      itemId: null,
      payerMembershipId: w.mem(w.memberMembershipId),
      amount: { amountMinor: AMOUNT, currency: 'PHP' },
      tripAmount: { amountMinor: AMOUNT, currency: 'PHP' },
      fxRate: '1',
      splitMethod: 'equal',
      version: 1,
    });
    expect(body.id).toMatch(/^exp_[0-9a-z]{26}$/);
    expect((body.shares as { membershipId: string }[]).map((s) => s.membershipId)).toEqual(
      [w.trip.ownerMembershipId, w.memberMembershipId, w.viewerMembershipId].sort().map(w.mem),
    );
    logsNoMoney(res.headers['x-request-id']);
  });

  it('logs a refusal by operation and code, and never the description or the amount', async () => {
    const w = await world();
    const forbidden = await create(w, w.viewer, dinner(w));
    expect(forbidden.statusCode).toBe(403);
    expect(refusalLine(forbidden.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.create',
      problem: 'forbidden',
    });
    logsNoMoney(forbidden.headers['x-request-id']);

    const unbalanced = await create(
      w,
      w.member,
      dinner(w, {
        split: {
          method: 'itemised',
          shares: [{ membershipId: w.mem(w.memberMembershipId), amountMinor: AMOUNT - 1 }],
        },
      }),
    );
    expect(unbalanced.statusCode).toBe(400);
    expect(refusalLine(unbalanced.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.create',
      problem: 'validation_failed',
    });
    logsNoMoney(unbalanced.headers['x-request-id']);
    expect(unbalanced.body).not.toContain(String(AMOUNT - 1));
  });

  it('replays a repeat under the same Idempotency-Key, writing one expense', async () => {
    const w = await world();
    const key = { 'idempotency-key': 'lantern-dinner' };
    const first = await create(w, w.member, dinner(w), key);
    expect(first.statusCode).toBe(201);
    const again = await create(w, w.member, dinner(w), key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const rows = await tdb.db
      .selectFrom('tribo.expenses')
      .select('id')
      .where('trip_id', '=', w.trip.tripId)
      .execute();
    expect(rows).toHaveLength(1);
    logsNoMoney(again.headers['x-request-id']);

    // Another body under the same key is refused, and writes nothing.
    const other = await create(w, w.member, dinner(w, { description: 'Breakfast' }), key);
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('checks access again on a replay: a member removed since gets 404, not the stored answer', async () => {
    const w = await world();
    const key = { 'idempotency-key': 'before-removal' };
    expect((await create(w, w.member, dinner(w), key)).statusCode).toBe(201);
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ deleted_at: new Date() })
      .where('id', '=', w.memberMembershipId)
      .execute();
    const replay = await create(w, w.member, dinner(w), key);
    expect(replay.statusCode).toBe(404);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
    expect(replay.body).not.toContain(DESCRIPTION);
    expect(refusalLine(replay.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.create',
      problem: 'not_found',
    });
  });
});

describe('expenses.get over HTTP', () => {
  const get = (caller: Caller, expensePath: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/expenses/${expensePath}`,
      cookies: caller.auth.cookies,
      headers: caller.auth.headers,
    });

  it('answers the expense to a member and masks its amounts for a viewer', async () => {
    const w = await world();
    const created = (await create(w, w.member, dinner(w))).json<{ id: string }>();
    const read = await get(w.owner, created.id);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(created);
    const masked = await get(w.viewer, created.id);
    expect(masked.statusCode).toBe(200);
    expect(masked.json()).toMatchObject({
      id: created.id,
      amount: { masked: true },
      tripAmount: { masked: true },
    });
    expect(masked.body).not.toContain('amountMinor');
    logsNoMoney(read.headers['x-request-id']);
  });

  it('answers 404 to a stranger, the same as for no expense, with its log line', async () => {
    const w = await world();
    const created = (await create(w, w.member, dinner(w))).json<{ id: string }>();
    const stranger = await signedInUser();
    const hidden = await get(stranger, created.id);
    const none = await get(
      stranger,
      encodeTypeId(ID_PREFIX.expense, '0192f000-0000-7000-8000-0000000000ff'),
    );
    expect(hidden.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(hidden.json<{ code: string }>().code).toBe(none.json<{ code: string }>().code);
    expect(refusalLine(hidden.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.get',
      problem: 'not_found',
    });
    logsNoMoney(hidden.headers['x-request-id']);
  });
});

describe('expenses.list over HTTP', () => {
  const list = (w: World, caller: Caller, query = '') =>
    app.inject({
      method: 'GET',
      url: `/v1/trips/${w.tripPath}/expenses${query}`,
      cookies: caller.auth.cookies,
      headers: caller.auth.headers,
    });

  it('answers a page of the ledger, masked for a viewer, and pages by cursor', async () => {
    const w = await world();
    const first = (await create(w, w.member, dinner(w, { spentOn: '2026-11-11' }))).json<{
      id: string;
    }>();
    const second = (await create(w, w.member, dinner(w))).json<{ id: string }>();
    const all = await list(w, w.owner);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ items: [first, second], nextCursor: null });
    const one = await list(w, w.owner, '?limit=1');
    const { nextCursor } = one.json<{ nextCursor: string }>();
    const rest = await list(w, w.owner, `?limit=1&cursor=${nextCursor}`);
    expect(rest.json()).toEqual({ items: [second], nextCursor: null });
    const masked = await list(w, w.viewer);
    expect(masked.body).not.toContain('amountMinor');
    logsNoMoney(all.headers['x-request-id']);
  });

  it('answers 404 to a stranger with its log line', async () => {
    const w = await world();
    const stranger = await signedInUser();
    const res = await list(w, stranger);
    expect(res.statusCode).toBe(404);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.list',
      problem: 'not_found',
    });
  });
});

describe('expenses.update over HTTP', () => {
  const update = (caller: Caller, expensePath: string, body: unknown, version?: string) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/expenses/${expensePath}`,
      payload: body as object,
      cookies: caller.auth.cookies,
      headers: {
        ...caller.auth.headers,
        ...(version === undefined ? {} : { 'if-match': version }),
      },
    });

  it('edits under If-Match, refreezing the shares, and answers 412 to a stale one with its log line', async () => {
    const w = await world();
    const created = (await create(w, w.member, dinner(w))).json<{ id: string }>();
    const edited = await update(
      w.member,
      created.id,
      { amount: { amountMinor: AMOUNT + 1, currency: 'PHP' }, description: `${DESCRIPTION} again` },
      '"1"',
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ version: 2, tripAmount: { amountMinor: AMOUNT + 1 } });
    logsNoMoney(edited.headers['x-request-id']);

    const stale = await update(w.member, created.id, { description: 'Late' }, '"1"');
    expect(stale.statusCode).toBe(412);
    expect(refusalLine(stale.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.update',
      problem: 'version_conflict',
    });
    const missing = await update(w.member, created.id, { description: 'Late' });
    expect(missing.statusCode).toBe(428);
    logsNoMoney(missing.headers['x-request-id']);
  });
});

describe('expenses.void over HTTP', () => {
  const remove = (caller: Caller, expensePath: string, version?: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/expenses/${expensePath}`,
      cookies: caller.auth.cookies,
      headers: {
        ...caller.auth.headers,
        ...(version === undefined ? {} : { 'if-match': version }),
      },
    });

  it('answers 204, and the expense is gone from reads; a viewer is refused with its log line', async () => {
    const w = await world();
    const created = (await create(w, w.member, dinner(w))).json<{ id: string }>();
    const refused = await remove(w.viewer, created.id, '"1"');
    expect(refused.statusCode).toBe(403);
    expect(refusalLine(refused.headers['x-request-id'])).toMatchObject({
      operationId: 'expenses.void',
      problem: 'forbidden',
    });
    const voided = await remove(w.member, created.id, '"1"');
    expect(voided.statusCode).toBe(204);
    logsNoMoney(voided.headers['x-request-id']);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/expenses/${created.id}`,
      cookies: w.member.auth.cookies,
      headers: w.member.auth.headers,
    });
    expect(read.statusCode).toBe(404);
  });
});
