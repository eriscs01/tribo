// @module-tag drop-a
// auth.mfa.confirm (Drop A): Confirm TOTP; returns 10 recovery codes; Codes shown once; Codes never stored for replay; a replay returns 200 with codes omitted and redacted = true (R2)
// Roles (self) at the HTTP edge, where only a signed-in caller gets in: auth-http.int.test.ts.
import { randomBytes } from 'node:crypto';
import { createIdentityService, type IdentityService, type SignedIn } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';
import { totpFor } from './totp.js';

const keys = keyring(new AppKey(randomBytes(32)));
const PASSWORD = 'correct horse battery';
const client = { ip: null, userAgent: null };

let tdb: TestDatabase;
let identity: IdentityService;
let n = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  identity = createIdentityService(tdb.db, keys, 'Tribo (tribo.test)');
});
afterAll(() => tdb.destroy());

const ctxFor = (caller: SignedIn): RequestContext => {
  n += 1;
  return { requestId: `req-confirm-${String(n)}`, surface: 'web', userId: caller.userId };
};

const account = (id: string) =>
  tdb.db.selectFrom('tribo.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const recoveryCodeRows = (id: string) =>
  tdb.db.selectFrom('tribo.mfa_recovery_codes').selectAll().where('user_id', '=', id).execute();

const events = (id: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .select(['action', 'version_before', 'version_after', 'request_id', 'chain_key'])
    .where('entity_id', '=', id)
    .orderBy('seq')
    .execute();

/** A signed-in user with a pending secret; `key` is what their authenticator app holds. */
async function enrolling() {
  const { userId } = await createUser(tdb.db, { password: PASSWORD });
  const { username } = await account(userId);
  const { session } = await identity.login(
    { requestId: `login-${userId}`, surface: 'web', userId: null },
    { username, password: PASSWORD },
    client,
  );
  const { key } = await identity.startMfaEnrolment(session);
  return { caller: session, key, username };
}

/** A six-digit code no step in the accepted drift window makes. */
function wrongCode(key: string): string {
  const now = Date.now();
  const valid = new Set([-30_000, 0, 30_000].map((drift) => totpFor(key, now + drift)));
  let code = 0;
  while (valid.has(String(code).padStart(6, '0'))) code += 1;
  return String(code).padStart(6, '0');
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('auth.mfa.confirm', () => {
  it('turns MFA on, returns ten recovery codes once and stores only their hashes', async () => {
    const { caller, key } = await enrolling();
    const result = await identity.confirmMfa(ctxFor(caller), caller, { code: totpFor(key) });

    expect(result.redacted).toBe(false);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    expect((await account(caller.userId)).mfa_enabled_at).not.toBeNull();
    const stored = await recoveryCodeRows(caller.userId);
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.code_hash).toMatch(/^\$argon2id\$/);
      expect(result.recoveryCodes).not.toContain(row.code_hash);
    }
  });

  it('makes sign-in need the second factor, and accepts a recovery code once', async () => {
    const { caller, key, username } = await enrolling();
    const { recoveryCodes = [] } = await identity.confirmMfa(ctxFor(caller), caller, {
      code: totpFor(key),
    });
    const ctx = ctxFor(caller);
    const credentials = { username, password: PASSWORD };

    expect((await refusal(identity.login(ctx, credentials, client))).code).toBe('mfa_required');
    await expect(
      identity.login(ctx, { ...credentials, totp: totpFor(key) }, client),
    ).resolves.toMatchObject({ session: { mfaVerified: true } });
    const recoveryCode = recoveryCodes[0] ?? '';
    await expect(
      identity.login(ctx, { ...credentials, recoveryCode }, client),
    ).resolves.toBeTruthy();
    expect(
      (await refusal(identity.login(ctx, { ...credentials, recoveryCode }, client))).code,
    ).toBe('unauthenticated');
  });

  it('marks the confirming session MFA-verified', async () => {
    const { caller, key } = await enrolling();
    await identity.confirmMfa(ctxFor(caller), caller, { code: totpFor(key) });
    const { mfa_verified_at: verifiedAt } = await tdb.db
      .selectFrom('tribo.sessions')
      .select('mfa_verified_at')
      .where('id', '=', caller.sessionId)
      .executeTakeFirstOrThrow();
    expect(verifiedAt).not.toBeNull();
  });

  it('refuses an invalid body or a wrong code with validation_failed, writing nothing', async () => {
    const { caller, key } = await enrolling();
    const before = await account(caller.userId);
    const wrong = wrongCode(key);

    for (const body of [{}, { code: '12345' }, { code: totpFor(key), extra: 1 }, { code: wrong }]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same row
      const error = await refusal(identity.confirmMfa(ctxFor(caller), caller, body));
      expect(error.code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await account(caller.userId)).toEqual(before);
    expect(await recoveryCodeRows(caller.userId)).toEqual([]);
    expect((await events(caller.userId)).map((e) => e.action)).toEqual(['login']);
  });

  it('refuses with invalid_transition without a pending secret, or once MFA is on', async () => {
    const { userId } = await createUser(tdb.db, { password: PASSWORD });
    const { username } = await account(userId);
    const { session: fresh } = await identity.login(
      { requestId: `login-${userId}`, surface: 'web', userId: null },
      { username, password: PASSWORD },
      client,
    );
    const code = '123456';
    expect((await refusal(identity.confirmMfa(ctxFor(fresh), fresh, { code }))).code).toBe(
      'invalid_transition',
    );

    const { caller, key } = await enrolling();
    const first = await identity.confirmMfa(ctxFor(caller), caller, { code: totpFor(key) });
    const again = await refusal(
      identity.confirmMfa(ctxFor(caller), caller, { code: totpFor(key) }),
    );
    expect(again.code).toBe('invalid_transition');
    // The codes the first confirm showed are still the ones stored.
    expect(await recoveryCodeRows(caller.userId)).toHaveLength(first.recoveryCodes?.length ?? 0);
  });

  it('records its mfa_enrol event and user snapshot in the one transaction', async () => {
    const { caller, key } = await enrolling();
    const ctx = ctxFor(caller);
    await identity.confirmMfa(ctx, caller, { code: totpFor(key) });

    const enrol = (await events(caller.userId)).filter((e) => e.action === 'mfa_enrol');
    expect(enrol).toEqual([
      {
        action: 'mfa_enrol',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
        chain_key: expect.stringMatching(/^auth:\d{4}-\d{2}$/) as unknown,
      },
    ]);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version', 'snapshot'])
      .where('entity_id', '=', caller.userId)
      .execute();
    expect(snapshots).toEqual([
      {
        entity_type: 'user',
        version: 2,
        snapshot: {
          username: caller.username,
          platformRole: 'user',
          status: 'active',
          mfaEnabled: true,
        },
      },
    ]);
    expect(JSON.stringify(snapshots)).not.toMatch(/argon2|secret|recovery/i);
    const { rows } = await sql<{ broken: string | null }>`
      SELECT audit.verify_chain(${enrol[0]?.chain_key ?? ''}) AS broken`.execute(tdb.db);
    expect(rows[0]?.broken).toBeNull();
  });

  it('takes no Idempotency-Key in 1a: a repeat is a new confirm, never a replay of the codes', async () => {
    // The HTTP edge ignores the header (auth-http.int.test.ts); nothing is kept to replay.
    const { caller, key } = await enrolling();
    const body = { code: totpFor(key) };
    await identity.confirmMfa(ctxFor(caller), caller, body);
    expect((await refusal(identity.confirmMfa(ctxFor(caller), caller, body))).code).toBe(
      'invalid_transition',
    );
    const kept = await tdb.db.selectFrom('tribo.idempotency_keys').select('key').execute();
    expect(kept).toEqual([]);
  });
});
