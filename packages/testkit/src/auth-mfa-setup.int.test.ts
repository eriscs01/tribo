// @module-tag drop-a
// auth.mfa.setup (Drop A): Start TOTP enrolment (secret); Secret shown once; No Idempotency-Key: each call replaces the pending secret (R2)
// Roles (self) at the HTTP edge, where only a signed-in caller gets in: auth-http.int.test.ts.
import { randomBytes } from 'node:crypto';
import { createIdentityService, type IdentityService, type SignedIn, writePath } from '@tribo/core';
import { AppKey, keyring, open, seal } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';

const keys = keyring(new AppKey(randomBytes(32)));
const PASSWORD = 'correct horse battery';
const ctx: RequestContext = { requestId: 'req-mfa-setup', surface: 'web', userId: null };
const client = { ip: null, userAgent: null };

let tdb: TestDatabase;
let identity: IdentityService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  identity = createIdentityService(tdb.db, writePath(tdb.db), keys, 'Tribo (tribo.test)');
});
afterAll(() => tdb.destroy());

const account = (id: string) =>
  tdb.db.selectFrom('tribo.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

async function signedInUser(): Promise<SignedIn> {
  const { userId } = await createUser(tdb.db, { password: PASSWORD });
  const { username } = await account(userId);
  const { session } = await identity.login(ctx, { username, password: PASSWORD }, client);
  return session;
}

const storedSecret = async (id: string) =>
  open(
    keys,
    { table: 'users', column: 'mfa_secret_enc', rowId: id },
    (await account(id)).mfa_secret_enc ?? Buffer.alloc(0),
  );

describe('auth.mfa.setup', () => {
  it('stores the pending secret sealed to the caller, MFA still off, and shows it once', async () => {
    const caller = await signedInUser();
    const setup = await identity.startMfaEnrolment(caller);

    expect(setup.uri).toMatch(
      new RegExp(
        `^otpauth://totp/Tribo%20\\(tribo\\.test\\)%3A${caller.username}\\?secret=${setup.key}&`,
      ),
    );
    const secret = await storedSecret(caller.userId);
    expect(secret).toHaveLength(20);
    // The key an app is given is the stored secret.
    expect(base32(secret)).toBe(setup.key);
    expect((await account(caller.userId)).mfa_enabled_at).toBeNull();

    // A pending secret is not MFA: sign-in still takes no second factor.
    await expect(
      identity.login(ctx, { username: caller.username, password: PASSWORD }, client),
    ).resolves.toMatchObject({ session: { mfaVerified: false } });
  });

  it('replaces the pending secret on each call', async () => {
    const caller = await signedInUser();
    const first = await identity.startMfaEnrolment(caller);
    const second = await identity.startMfaEnrolment(caller);
    expect(second.key).not.toBe(first.key);
    expect(base32(await storedSecret(caller.userId))).toBe(second.key);
  });

  it('writes only the caller’s own account', async () => {
    const caller = await signedInUser();
    const other = await createUser(tdb.db);
    await identity.startMfaEnrolment(caller);
    expect((await account(other.userId)).mfa_secret_enc).toBeNull();
  });

  it('refuses with invalid_transition once MFA is on, keeping the enrolled secret', async () => {
    const caller = await signedInUser();
    const enrolled = randomBytes(20);
    await tdb.db
      .updateTable('tribo.users')
      .set({
        mfa_secret_enc: sealFor(caller.userId, enrolled),
        mfa_enabled_at: new Date(),
      })
      .where('id', '=', caller.userId)
      .execute();

    const refused = await identity.startMfaEnrolment(caller).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('invalid_transition');
    expect(await storedSecret(caller.userId)).toEqual(enrolled);
  });

  it('records no audit event or snapshot and bumps no version: a pending secret is credential state', async () => {
    const caller = await signedInUser();
    const before = await account(caller.userId);
    await identity.startMfaEnrolment(caller);

    expect((await account(caller.userId)).version).toBe(before.version);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select('version')
      .where('entity_id', '=', caller.userId)
      .execute();
    expect(snapshots).toEqual([]);
    const actions = await tdb.db
      .selectFrom('audit.audit_events')
      .select('action')
      .where('entity_id', '=', caller.userId)
      .execute();
    expect(actions.map((e) => e.action)).toEqual(['login']);
  });
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes: Buffer): string {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((chunk) => BASE32.charAt(parseInt(chunk.padEnd(5, '0'), 2)))
    .join('');
}

function sealFor(userId: string, secret: Buffer): Buffer {
  return seal(keys, { table: 'users', column: 'mfa_secret_enc', rowId: userId }, secret);
}
