// @module-tag drop-a
// me.password.change (Drop A): Change own password; revokes other sessions; Decided (G1); Never replayed (rule 6)
// Roles (self) at the HTTP edge, where only a signed-in caller gets in: auth-http.int.test.ts.
import { randomBytes } from 'node:crypto';
import { createIdentityService, type IdentityService, writePath } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createUser } from './factories.js';

const OLD = 'correct horse battery';
const NEW = 'staple paperclip lantern';
const client = { ip: null, userAgent: null };

let tdb: TestDatabase;
let identity: IdentityService;
let n = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  identity = createIdentityService(
    tdb.db,
    writePath(tdb.db),
    keyring(new AppKey(randomBytes(32))),
    'Tribo (tribo.test)',
  );
});
afterAll(() => tdb.destroy());

const ctx = (userId: string | null = null): RequestContext => {
  n += 1;
  return { requestId: `req-password-${String(n)}`, surface: 'web', userId };
};

const account = (id: string) =>
  tdb.db.selectFrom('tribo.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** An account signed in twice: `current` changes the password, `other` is another device. */
async function signedInTwice() {
  const { userId } = await createUser(tdb.db, { password: OLD });
  const { username } = await account(userId);
  const current = await identity.login(ctx(), { username, password: OLD }, client);
  const other = await identity.login(ctx(), { username, password: OLD }, client);
  return { userId, username, caller: current.session, current, other };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('me.password.change', () => {
  it('sets the new password and revokes the caller’s other sessions, keeping this one', async () => {
    const { userId, username, caller, current, other } = await signedInTwice();
    await identity.changePassword(ctx(userId), caller, { currentPassword: OLD, newPassword: NEW });

    expect(await identity.authenticate(current.token)).not.toBeNull();
    expect(await identity.authenticate(other.token)).toBeNull();
    expect((await refusal(identity.login(ctx(), { username, password: OLD }, client))).code).toBe(
      'unauthenticated',
    );
    await expect(identity.login(ctx(), { username, password: NEW }, client)).resolves.toBeTruthy();
  });

  it('changes only the caller’s own account', async () => {
    const { userId, caller } = await signedInTwice();
    const bystander = await signedInTwice();
    const before = await account(bystander.userId);
    await identity.changePassword(ctx(userId), caller, { currentPassword: OLD, newPassword: NEW });

    expect(await account(bystander.userId)).toEqual(before);
    expect(await identity.authenticate(bystander.other.token)).not.toBeNull();
  });

  it('refuses a wrong current password with validation_failed, counting it towards the lockout', async () => {
    const { userId, caller, other } = await signedInTwice();
    const before = await account(userId);
    const error = await refusal(
      identity.changePassword(ctx(userId), caller, {
        currentPassword: 'not my password',
        newPassword: NEW,
      }),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.extra.errors).toEqual([expect.objectContaining({ path: '/currentPassword' })]);

    const after = await account(userId);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.failed_login_count).toBe(before.failed_login_count + 1);
    expect(await identity.authenticate(other.token)).not.toBeNull();
  });

  it('answers rate_limited while the account is locked, even with the right password', async () => {
    const { userId, caller } = await signedInTwice();
    await tdb.db
      .updateTable('tribo.users')
      .set({ locked_until: new Date(Date.now() + 15 * 60_000) })
      .where('id', '=', userId)
      .execute();
    const error = await refusal(
      identity.changePassword(ctx(userId), caller, { currentPassword: OLD, newPassword: NEW }),
    );
    expect(error.code).toBe('rate_limited');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const { userId, caller, other } = await signedInTwice();
    const before = await account(userId);
    for (const body of [
      {},
      { currentPassword: OLD },
      { currentPassword: OLD, newPassword: 'too short' },
      { currentPassword: OLD, newPassword: NEW, extra: 1 },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same row
      const error = await refusal(identity.changePassword(ctx(userId), caller, body));
      expect(error.code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await account(userId)).toEqual(before);
    expect(await identity.authenticate(other.token)).not.toBeNull();
  });

  it('records its password_change event, with no snapshot, in the one transaction', async () => {
    const { userId, caller } = await signedInTwice();
    const before = await account(userId);
    const request = ctx(userId);
    await identity.changePassword(request, caller, { currentPassword: OLD, newPassword: NEW });

    const changes = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['action', 'actor_user_id', 'request_id', 'version_before', 'version_after'])
      .where('entity_id', '=', userId)
      .where('action', '=', 'password_change')
      .execute();
    expect(changes).toEqual([
      {
        action: 'password_change',
        actor_user_id: userId,
        request_id: request.requestId,
        version_before: null,
        version_after: null,
      },
    ]);
    // A password is a credential: no version bump and no snapshot to carry its hash.
    expect((await account(userId)).version).toBe(before.version);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select('version')
      .where('entity_id', '=', userId)
      .execute();
    expect(snapshots).toEqual([]);
  });

  it('is never replayed: a repeat with the old password is refused', async () => {
    const { userId, caller } = await signedInTwice();
    const body = { currentPassword: OLD, newPassword: NEW };
    await identity.changePassword(ctx(userId), caller, body);
    expect((await refusal(identity.changePassword(ctx(userId), caller, body))).code).toBe(
      'validation_failed',
    );
  });
});
