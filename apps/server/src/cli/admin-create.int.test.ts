// Exit criterion 1 without the host: `tribo admin create` makes the first admin, who
// enrols TOTP from the printed key and signs in with it over HTTP.
import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@tribo/contract';
import {
  createIdentityService,
  createItemsService,
  createTripsService,
  writePath,
  type IdentityService,
} from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { createTestDatabase, totpFor, type TestDatabase } from '@tribo/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHandlers } from '../handlers/auth.js';
import { itemHandlers } from '../handlers/items.js';
import { tripHandlers } from '../handlers/trips.js';
import { buildServer } from '../server.js';
import { adminCreate } from './admin-create.js';
import { CliError, type CliIo } from './io.js';

const PASSWORD = 'correct horse battery';
const csrf = randomBytes(32);

let tdb: TestDatabase;
let identity: IdentityService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  identity = createIdentityService(tdb.db, keyring(new AppKey(randomBytes(32))));
});
afterAll(() => tdb.destroy());

/** An operator at the terminal: answers each prompt; the TOTP prompt from the printed key. */
function operator(answers: { password: string; repeat?: string; totp?: (key: string) => string }) {
  const said: string[] = [];
  const io: CliIo = {
    say: (text) => said.push(text),
    ask: (question) => {
      if (question.startsWith('Password')) return Promise.resolve(answers.password);
      if (question.startsWith('Repeat')) return Promise.resolve(answers.repeat ?? answers.password);
      const key = said.map((l) => /key: (\w+)/.exec(l)?.[1]).find(Boolean) ?? '';
      return Promise.resolve((answers.totp ?? totpFor)(key));
    },
  };
  return { io, said };
}

const run = (io: CliIo, args: string[]) =>
  adminCreate(
    {
      identity,
      io,
      issuer: 'Tribo (tribo.test)',
      ctx: { requestId: 'cli-test', surface: 'system', userId: null },
    },
    args,
  );

describe('tribo admin create', () => {
  it('creates the admin, who signs in with password + TOTP and gets an MFA session', async () => {
    const { io, said } = operator({ password: PASSWORD });
    await run(io, ['ana', 'Ana', 'Admin']);
    expect(said.join('\n')).toMatch(/otpauth:\/\/totp\/Tribo%20\(tribo\.test\)%3Aana\?secret=/);
    expect(said.filter((l) => /^ {2}[a-z2-9]{5}-[a-z2-9]{5}$/.test(l))).toHaveLength(10);
    const key = said.map((l) => /key: (\w+)/.exec(l)?.[1]).find(Boolean) ?? '';

    const app = await buildServer({
      trustedProxies: ['loopback'],
      csrfSecret: csrf,
      authenticate: (token) => identity.authenticate(token),
      handlers: {
        ...authHandlers(identity, csrf),
        ...tripHandlers(createTripsService(tdb.db, writePath(tdb.db))),
        ...itemHandlers(createItemsService(tdb.db, writePath(tdb.db))),
      },
      ping: () => Promise.resolve(),
      logLevel: 'silent',
    });
    try {
      const passwordOnly = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'ana', password: PASSWORD },
      });
      expect(passwordOnly.json()).toMatchObject({ code: 'mfa_required' });

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'ana', password: PASSWORD, totp: totpFor(key) },
      });
      expect(login.statusCode).toBe(201);
      expect(login.json()).toMatchObject({
        user: { username: 'ana', platformRole: 'admin' },
        mfaVerified: true,
      });
      const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

      const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        cookies: { [SESSION_COOKIE]: cookie?.value ?? '' },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ user: { username: 'ana' }, mfaVerified: true });
    } finally {
      await app.close();
    }
  });

  it('creates nothing when the code is wrong three times', async () => {
    const { io } = operator({ password: PASSWORD, totp: () => '000000' });
    await expect(run(io, ['ben'])).rejects.toThrow(CliError);
    const rows = await tdb.db
      .selectFrom('tribo.users')
      .select('id')
      .where('username', '=', 'ben')
      .execute();
    expect(rows).toEqual([]);
  });

  it('stops on a mismatched repeat or a taken username', async () => {
    await expect(
      run(operator({ password: PASSWORD, repeat: 'something else!' }).io, ['cyd']),
    ).rejects.toThrow(/do not match/);
    await run(operator({ password: PASSWORD }).io, ['dee']);
    await expect(run(operator({ password: PASSWORD }).io, ['DEE'])).rejects.toThrow(/taken/);
  });
});
