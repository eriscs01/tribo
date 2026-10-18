// Identity skeleton (s0 task 9): Argon2id, the bootstrap admin with TOTP, sign-in with
// session rows, and the lockout after 5 failures.
import { randomBytes } from 'node:crypto';
import { createIdentityService, startTotpEnrolment, type IdentityService } from '@tribo/core';
import { AppKey, keyring, open } from '@tribo/crypto';
import type { RequestContext } from '@tribo/platform';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';
import { totpFor } from './totp.js';

const keys = keyring(new AppKey(randomBytes(32)));
const client = { ip: '198.51.100.7', userAgent: 'vitest' };
const PASSWORD = 'correct horse battery';

let tdb: TestDatabase;
let identity: IdentityService;
let n = 0;
const seq = () => {
  n += 1;
  return String(n);
};

const ctx = (): RequestContext => ({
  requestId: `req-${seq()}`,
  surface: 'web',
  userId: null,
});

beforeAll(async () => {
  tdb = await createTestDatabase();
  identity = createIdentityService(tdb.db, keys, 'Tribo (tribo.test)');
});
afterAll(() => tdb.destroy());

/** An admin made the way `tribo admin create` makes one; returns its TOTP key too. */
async function admin(username = `admin_${seq()}`) {
  const enrolment = startTotpEnrolment('Tribo', username);
  const created = await identity.createAdmin(
    { requestId: `cli-${username}`, surface: 'system', userId: null },
    {
      username,
      displayName: 'Ana Admin',
      password: PASSWORD,
      totpSecret: enrolment.secret,
      totpCode: totpFor(enrolment.key),
    },
  );
  return { username, key: enrolment.key, ...created };
}

const user = (id: string) =>
  tdb.db.selectFrom('tribo.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const events = (id: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('entity_id', '=', id)
    .orderBy('occurred_at')
    .orderBy('seq')
    .execute();

async function chainBroken(chainKey: string) {
  const { rows } = await sql<{ broken: string | null }>`
    SELECT audit.verify_chain(${chainKey}) AS broken`.execute(tdb.db);
  return rows[0]?.broken ?? null;
}

describe('tribo admin create', () => {
  it('inserts the admin disabled, enrols TOTP and activates it, with its person, in one go', async () => {
    const a = await admin();
    const row = await user(a.userId);
    expect(row).toMatchObject({ platform_role: 'admin', status: 'active', version: 2 });
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.mfa_enabled_at).not.toBeNull();

    const person = await tdb.db
      .selectFrom('tribo.persons')
      .select(['id', 'display_name'])
      .where('user_id', '=', a.userId)
      .executeTakeFirstOrThrow();
    expect(person).toEqual({ id: a.personId, display_name: 'Ana Admin' });

    expect(
      (await events(a.userId)).map((e) => [e.action, e.version_before, e.version_after]),
    ).toEqual([
      ['create', null, 1],
      ['mfa_enrol', 1, 2],
    ]);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'snapshot'])
      .where('entity_id', 'in', [a.userId, a.personId])
      .orderBy('entity_type', 'desc')
      .orderBy('version')
      .execute();
    expect(snapshots).toEqual([
      {
        entity_type: 'user',
        version: 1,
        snapshot: {
          username: a.username,
          platformRole: 'admin',
          status: 'disabled',
          mfaEnabled: false,
        },
      },
      {
        entity_type: 'user',
        version: 2,
        snapshot: {
          username: a.username,
          platformRole: 'admin',
          status: 'active',
          mfaEnabled: true,
        },
      },
      {
        entity_type: 'person',
        version: 1,
        snapshot: {
          userId: a.userId,
          displayName: 'Ana Admin',
          contacts: {},
          dietary: null,
          drivingLicence: false,
          emergencyContactEnc: null,
        },
      },
    ]);
    expect(JSON.stringify(snapshots)).not.toMatch(/argon2|mfa_secret/);
    expect(await chainBroken('platform')).toBeNull();
  });

  it('stores the TOTP secret sealed to its row and the recovery codes only as hashes', async () => {
    const a = await admin();
    const row = await user(a.userId);
    const field = { table: 'users', column: 'mfa_secret_enc', rowId: a.userId };
    expect(open(keys, field, row.mfa_secret_enc ?? Buffer.alloc(0)).length).toBe(20);
    expect(() =>
      open(keys, { ...field, rowId: a.personId }, row.mfa_secret_enc ?? Buffer.alloc(0)),
    ).toThrow();

    expect(a.recoveryCodes).toHaveLength(10);
    const stored = await tdb.db
      .selectFrom('tribo.mfa_recovery_codes')
      .select('code_hash')
      .where('user_id', '=', a.userId)
      .execute();
    expect(stored).toHaveLength(10);
    for (const { code_hash: codeHash } of stored) {
      expect(codeHash).toMatch(/^\$argon2id\$/);
      expect(a.recoveryCodes).not.toContain(codeHash);
    }
  });

  it('creates nothing when the TOTP code does not match', async () => {
    const enrolment = startTotpEnrolment('Tribo', 'never_made');
    await expect(
      identity.createAdmin(ctx(), {
        username: 'never_made',
        displayName: 'x',
        password: PASSWORD,
        totpSecret: enrolment.secret,
        totpCode: totpFor(startTotpEnrolment('Tribo', 'other').key),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const found = await tdb.db
      .selectFrom('tribo.users')
      .select('id')
      .where('username', '=', 'never_made')
      .execute();
    expect(found).toEqual([]);
  });

  it('refuses a taken username, case-insensitively', async () => {
    const a = await admin();
    await expect(admin(a.username.toUpperCase())).rejects.toMatchObject({ code: 'username_taken' });
  });

  it('refuses a short password', async () => {
    const enrolment = startTotpEnrolment('Tribo', 'short_pw');
    await expect(
      identity.createAdmin(ctx(), {
        username: 'short_pw',
        displayName: 'x',
        password: 'too short',
        totpSecret: enrolment.secret,
        totpCode: totpFor(enrolment.key),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('sign-in', () => {
  it('asks an MFA account for its second factor, then opens an MFA-verified session', async () => {
    const a = await admin();
    await expect(
      identity.login(ctx(), { username: a.username, password: PASSWORD }, client),
    ).rejects.toMatchObject({ code: 'mfa_required' });

    const { token, session } = await identity.login(
      ctx(),
      { username: a.username.toUpperCase(), password: PASSWORD, totp: totpFor(a.key) },
      client,
    );
    expect(session).toMatchObject({ userId: a.userId, platformRole: 'admin', mfaVerified: true });

    const rows = await tdb.db
      .selectFrom('tribo.sessions')
      .selectAll()
      .where('user_id', '=', a.userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip: '198.51.100.7', user_agent: 'vitest', revoked_at: null });
    expect(rows[0]?.mfa_verified_at).not.toBeNull();
    expect(rows[0]?.token_hash.toString('base64url')).not.toBe(token);

    expect(await identity.authenticate(token)).toMatchObject({
      userId: a.userId,
      mfaVerified: true,
    });
    expect((await user(a.userId)).last_login_at).not.toBeNull();
    const login = (await events(a.userId)).find((e) => e.action === 'login');
    expect(login).toMatchObject({ actor_user_id: a.userId, surface: 'web' });
    expect(login?.chain_key).toMatch(/^auth:\d{4}-\d{2}$/);
    expect(await chainBroken(login?.chain_key ?? '')).toBeNull();
  });

  it('signs in an account without MFA with its password alone', async () => {
    const u = await createUser(tdb.db, { password: PASSWORD });
    const { username } = await user(u.userId);
    const { session } = await identity.login(ctx(), { username, password: PASSWORD }, client);
    expect(session).toMatchObject({ userId: u.userId, mfaVerified: false });
  });

  it('accepts each recovery code once in place of TOTP', async () => {
    const a = await admin();
    const code = a.recoveryCodes[0] ?? '';
    const input = { username: a.username, password: PASSWORD, recoveryCode: code.toUpperCase() };
    expect((await identity.login(ctx(), input, client)).session.mfaVerified).toBe(true);
    await expect(identity.login(ctx(), input, client)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses an unknown username like a wrong password and records it', async () => {
    const r = ctx();
    await expect(
      identity.login(r, { username: 'nobody_here', password: PASSWORD }, client),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    const failed = await tdb.db
      .selectFrom('audit.audit_events')
      .selectAll()
      .where('request_id', '=', r.requestId)
      .executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ action: 'login_failed', entity_id: null, actor_user_id: null });
  });

  it('refuses a disabled account even with the right password', async () => {
    const a = await admin();
    // An admin may be disabled without losing MFA (users_admin_needs_mfa allows it).
    await tdb.db
      .updateTable('tribo.users')
      .set({ status: 'disabled' })
      .where('id', '=', a.userId)
      .execute();
    await expect(
      identity.login(
        ctx(),
        { username: a.username, password: PASSWORD, totp: totpFor(a.key) },
        client,
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('lockout', () => {
  const wrong = (username: string) =>
    identity.login(ctx(), { username, password: 'not the password' }, client);

  it('locks the username for 15 minutes after 5 failures, even for the right password', async () => {
    const a = await admin();
    for (let i = 0; i < 4; i += 1)
      // eslint-disable-next-line no-await-in-loop -- each failure must land before the next
      await expect(wrong(a.username)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await user(a.userId)).toMatchObject({ failed_login_count: 4, locked_until: null });

    await expect(wrong(a.username)).rejects.toMatchObject({ code: 'unauthenticated' });
    const locked = await user(a.userId);
    expect(locked.failed_login_count).toBe(0);
    // locked_until comes from the database clock, so measure against it, not the host's.
    const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tdb.db);
    const minutes =
      ((locked.locked_until?.getTime() ?? 0) - (rows[0]?.now.getTime() ?? 0)) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    const right = { username: a.username, password: PASSWORD, totp: totpFor(a.key) };
    await expect(identity.login(ctx(), right, client)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect((await events(a.userId)).filter((e) => e.action === 'login_failed')).toHaveLength(6);

    // Once the lock has passed, the right credentials work and the count is clean.
    await tdb.db
      .updateTable('tribo.users')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', a.userId)
      .execute();
    await identity.login(ctx(), right, client);
    expect(await user(a.userId)).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  it('counts a wrong TOTP code as a failure', async () => {
    const a = await admin();
    const code = totpFor(a.key) === '000000' ? '111111' : '000000';
    await expect(
      identity.login(ctx(), { username: a.username, password: PASSWORD, totp: code }, client),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await user(a.userId)).failed_login_count).toBe(1);
  });

  it('counts concurrent failures without losing any', async () => {
    const a = await admin();
    await Promise.allSettled([1, 2, 3].map(() => wrong(a.username)));
    expect((await user(a.userId)).failed_login_count).toBe(3);
  });
});

describe('sessions', () => {
  async function signIn() {
    const a = await admin();
    const { token, session } = await identity.login(
      ctx(),
      { username: a.username, password: PASSWORD, totp: totpFor(a.key) },
      client,
    );
    return { a, token, sessionId: session.sessionId };
  }

  it('signs out by revoking the row; a second sign-out is harmless', async () => {
    const { a, token } = await signIn();
    await identity.logout({ ...ctx(), userId: a.userId }, token);
    await identity.logout({ ...ctx(), userId: a.userId }, token);
    expect(await identity.authenticate(token)).toBeNull();
    expect((await events(a.userId)).filter((e) => e.action === 'logout')).toHaveLength(1);
  });

  it('ends a session past its idle or absolute expiry', async () => {
    const idle = await signIn();
    await tdb.db
      .updateTable('tribo.sessions')
      .set({ idle_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', idle.sessionId)
      .execute();
    expect(await identity.authenticate(idle.token)).toBeNull();

    const absolute = await signIn();
    await tdb.db
      .updateTable('tribo.sessions')
      .set({ absolute_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', absolute.sessionId)
      .execute();
    expect(await identity.authenticate(absolute.token)).toBeNull();
  });

  it('slides the 7-day idle expiry on use, never past the absolute expiry', async () => {
    const { token, sessionId } = await signIn();
    const day = 86_400_000;
    // Pretend the session was last used two days ago and is close to its absolute end.
    await tdb.db
      .updateTable('tribo.sessions')
      .set({
        last_seen_at: new Date(Date.now() - 2 * day),
        idle_expires_at: new Date(Date.now() + 5 * day),
        absolute_expires_at: new Date(Date.now() + 3 * day),
      })
      .where('id', '=', sessionId)
      .execute();
    expect(await identity.authenticate(token)).not.toBeNull();
    const row = await tdb.db
      .selectFrom('tribo.sessions')
      .select(['idle_expires_at', 'absolute_expires_at'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(row.idle_expires_at).toEqual(row.absolute_expires_at);
  });

  it('ends the sessions of an account once it is disabled', async () => {
    const { a, token } = await signIn();
    await tdb.db
      .updateTable('tribo.users')
      .set({ status: 'disabled' })
      .where('id', '=', a.userId)
      .execute();
    expect(await identity.authenticate(token)).toBeNull();
  });
});
