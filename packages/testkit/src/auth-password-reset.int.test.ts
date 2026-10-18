// @module-tag drop-a
// auth.passwordReset (Drop A): Use admin reset link {token, newPassword}; revokes all sessions and refresh tokens; Token in body, never URL; Single-use token makes it naturally idempotent: a repeat gets reset_link_used (R2)
// Refresh tokens are OAuth (1b): none exist in 1a, so sessions are all there is to revoke.
import { randomBytes } from 'node:crypto';
import { createIdentityService, type IdentityService } from '@tribo/core';
import { AppKey, keyring } from '@tribo/crypto';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createResetLink, createUser } from './factories.js';

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
    keyring(new AppKey(randomBytes(32))),
    'Tribo (tribo.test)',
  );
});
afterAll(() => tdb.destroy());

/** The link holder is anonymous: auth.passwordReset is public. */
const ctx = (): RequestContext => {
  n += 1;
  return { requestId: `req-reset-${String(n)}`, surface: 'web', userId: null };
};

const account = (id: string) =>
  tdb.db.selectFrom('tribo.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** An account with two live sessions and an admin's reset link for it. */
async function withLink(expiresAt?: Date) {
  const { userId } = await createUser(tdb.db, { password: OLD });
  const { userId: adminId } = await createUser(tdb.db, { platformRole: 'admin' });
  const { username } = await account(userId);
  const sessions = await Promise.all(
    [1, 2].map(() => identity.login(ctx(), { username, password: OLD }, client)),
  );
  const token = await createResetLink(tdb.db, {
    userId,
    createdBy: adminId,
    ...(expiresAt ? { expiresAt } : {}),
  });
  return { userId, adminId, username, token, sessionTokens: sessions.map((s) => s.token) };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('auth.passwordReset', () => {
  it('sets the new password: the old one stops working and the new one signs in', async () => {
    const { username, token } = await withLink();
    await identity.resetPassword(ctx(), { token, newPassword: NEW });

    expect((await refusal(identity.login(ctx(), { username, password: OLD }, client))).code).toBe(
      'unauthenticated',
    );
    await expect(identity.login(ctx(), { username, password: NEW }, client)).resolves.toBeTruthy();
  });

  it('revokes every session of the account, and lifts a lockout', async () => {
    const { userId, token, sessionTokens } = await withLink();
    await tdb.db
      .updateTable('tribo.users')
      .set({ locked_until: new Date(Date.now() + 15 * 60_000), failed_login_count: 3 })
      .where('id', '=', userId)
      .execute();
    await identity.resetPassword(ctx(), { token, newPassword: NEW });

    for (const sessionToken of sessionTokens) {
      // eslint-disable-next-line no-await-in-loop -- two sessions, checked one by one
      expect(await identity.authenticate(sessionToken)).toBeNull();
    }
    expect(await account(userId)).toMatchObject({ locked_until: null, failed_login_count: 0 });
  });

  it('is open to anyone holding the link, and resets only the link’s own account', async () => {
    const { userId, token } = await withLink();
    const bystander = await createUser(tdb.db, { password: OLD });
    const before = await account(bystander.userId);
    await identity.resetPassword(ctx(), { token, newPassword: NEW });

    expect(await account(bystander.userId)).toEqual(before);
    expect((await account(userId)).password_changed_at.getTime()).toBeGreaterThan(
      before.password_changed_at.getTime(),
    );
  });

  it('answers reset_link_used for a used link: a repeat changes nothing', async () => {
    const { userId, username, token } = await withLink();
    await identity.resetPassword(ctx(), { token, newPassword: NEW });
    const after = await account(userId);

    const repeat = await refusal(
      identity.resetPassword(ctx(), { token, newPassword: 'another long password' }),
    );
    expect(repeat.code).toBe('reset_link_used');
    expect(await account(userId)).toEqual(after);
    await expect(identity.login(ctx(), { username, password: NEW }, client)).resolves.toBeTruthy();
  });

  it('answers reset_link_used for an expired, revoked or unknown link, or a deleted account', async () => {
    const expired = await withLink(new Date(Date.now() - 60_000));
    const revoked = await withLink();
    await tdb.db
      .updateTable('tribo.password_reset_links')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', revoked.userId)
      .execute();
    const deleted = await withLink();
    await tdb.db
      .updateTable('tribo.users')
      .set({ deleted_at: new Date() })
      .where('id', '=', deleted.userId)
      .execute();
    const unknown = randomBytes(32).toString('base64url');
    const hashBefore = (await account(expired.userId)).password_hash;

    for (const token of [expired.token, revoked.token, deleted.token, unknown]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each named by its token
      const error = await refusal(identity.resetPassword(ctx(), { token, newPassword: NEW }));
      expect(error.code).toBe('reset_link_used');
    }
    expect((await account(expired.userId)).password_hash).toBe(hashBefore);
  });

  it('revokes the account’s other unused reset links', async () => {
    const { userId, adminId, token } = await withLink();
    const other = await createResetLink(tdb.db, { userId, createdBy: adminId });
    await identity.resetPassword(ctx(), { token, newPassword: NEW });
    expect(
      (await refusal(identity.resetPassword(ctx(), { token: other, newPassword: NEW }))).code,
    ).toBe('reset_link_used');
  });

  it('refuses an invalid body with validation_failed, writing nothing and keeping the link', async () => {
    const { userId, token, username } = await withLink();
    const before = await account(userId);
    for (const body of [
      {},
      { token },
      { token, newPassword: 'too short' },
      { token, newPassword: NEW, extra: true },
      { token: '', newPassword: NEW },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same row
      const error = await refusal(identity.resetPassword(ctx(), body));
      expect(error.code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await account(userId)).toEqual(before);
    await identity.resetPassword(ctx(), { token, newPassword: NEW });
    await expect(identity.login(ctx(), { username, password: NEW }, client)).resolves.toBeTruthy();
  });

  it('records its password_reset event, with no snapshot, in the one transaction', async () => {
    const { userId, token } = await withLink();
    const before = await account(userId);
    const request = ctx();
    await identity.resetPassword(request, { token, newPassword: NEW });

    const resets = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['action', 'actor_user_id', 'request_id', 'version_before', 'version_after'])
      .where('entity_id', '=', userId)
      .where('action', '=', 'password_reset')
      .execute();
    expect(resets).toEqual([
      {
        action: 'password_reset',
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
});
