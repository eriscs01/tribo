import type { ModuleDb } from '@tribo/db';
import { sql } from 'kysely';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from './policy.js';

/** The identity module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type IdentityDb = ModuleDb<'identity'>;

/** The account a sign-in names, with `locked` judged by the database clock. */
export function findLoginAccount(db: IdentityDb, username: string) {
  return db
    .selectFrom('tribo.users')
    .select([
      'id',
      'username',
      'password_hash',
      'mfa_secret_enc',
      'mfa_enabled_at',
      'platform_role',
      'status',
    ])
    .select(sql<boolean>`coalesce(locked_until > now(), false)`.as('locked'))
    .where('username', '=', username)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/**
 * Counts one failed guess in a single statement, so concurrent attempts cannot both read
 * the old count. The failure that reaches the limit sets the lock and restarts the count.
 */
export async function countFailedLogin(db: IdentityDb, userId: string): Promise<void> {
  const reachesLimit = sql<boolean>`failed_login_count + 1 >= ${MAX_FAILED_LOGINS}`;
  await db
    .updateTable('tribo.users')
    .set({
      failed_login_count: sql`CASE WHEN ${reachesLimit} THEN 0 ELSE failed_login_count + 1 END`,
      locked_until: sql`CASE WHEN ${reachesLimit}
        THEN now() + make_interval(mins => ${LOCKOUT_MINUTES}) ELSE locked_until END`,
    })
    .where('id', '=', userId)
    .execute();
}

/** Login bookkeeping is operational state: it bumps no version and takes no snapshot. */
export async function recordLogin(db: IdentityDb, userId: string): Promise<void> {
  await db
    .updateTable('tribo.users')
    .set({ failed_login_count: 0, locked_until: null, last_login_at: sql`now()` })
    .where('id', '=', userId)
    .execute();
}

export function unusedRecoveryCodes(db: IdentityDb, userId: string) {
  return db
    .selectFrom('tribo.mfa_recovery_codes')
    .select(['id', 'code_hash'])
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
}

/** True when this call used the code; a concurrent use of the same code gets false. */
export async function useRecoveryCode(db: IdentityDb, codeId: string): Promise<boolean> {
  const used = await db
    .updateTable('tribo.mfa_recovery_codes')
    .set({ used_at: sql`now()` })
    .where('id', '=', codeId)
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return used !== undefined;
}

export async function replaceRecoveryCodes(
  db: IdentityDb,
  userId: string,
  codeHashes: readonly string[],
): Promise<void> {
  await db.deleteFrom('tribo.mfa_recovery_codes').where('user_id', '=', userId).execute();
  await db
    .insertInto('tribo.mfa_recovery_codes')
    .values(codeHashes.map((code_hash) => ({ user_id: userId, code_hash })))
    .execute();
}

/** Lifetimes come from the column defaults (7-day idle, 30-day absolute). */
export function insertSession(
  db: IdentityDb,
  session: {
    userId: string;
    tokenHash: Buffer;
    mfaVerified: boolean;
    ip: string | null;
    userAgent: string | null;
  },
) {
  return db
    .insertInto('tribo.sessions')
    .values({
      user_id: session.userId,
      token_hash: session.tokenHash,
      mfa_verified_at: session.mfaVerified ? sql`now()` : null,
      ip: session.ip,
      user_agent: session.userAgent,
    })
    .returning(['id', 'absolute_expires_at'])
    .executeTakeFirstOrThrow();
}

/**
 * Finds the live session for a token hash and slides its idle expiry forward, in one
 * statement. The idle window is read back from the row (idle_expires_at − last_seen_at)
 * rather than restated here, so the column default stays its only owner; it never passes
 * the absolute expiry. A session of a disabled or deleted account is not live.
 */
export function touchSession(db: IdentityDb, tokenHash: Buffer) {
  return db
    .updateTable('tribo.sessions as s')
    .from('tribo.users as u')
    .set({
      last_seen_at: sql`now()`,
      idle_expires_at: sql`least(now() + (s.idle_expires_at - s.last_seen_at), s.absolute_expires_at)`,
    })
    .whereRef('u.id', '=', 's.user_id')
    .where('s.token_hash', '=', tokenHash)
    .where('s.revoked_at', 'is', null)
    .where('s.idle_expires_at', '>', sql<Date>`now()`)
    .where('s.absolute_expires_at', '>', sql<Date>`now()`)
    .where('u.status', '=', 'active')
    .where('u.deleted_at', 'is', null)
    .returning([
      's.id as sessionId',
      's.mfa_verified_at',
      's.absolute_expires_at',
      'u.id as userId',
      'u.username',
      'u.platform_role',
    ])
    .executeTakeFirst();
}

/** Revokes the live session for a token hash; returns its user, or undefined if none was live. */
export async function revokeSession(db: IdentityDb, tokenHash: Buffer) {
  return db
    .updateTable('tribo.sessions')
    .set({ revoked_at: sql`now()` })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .returning(['id', 'user_id'])
    .executeTakeFirst();
}

/** The bootstrap admin starts disabled: users_admin_needs_mfa holds until TOTP is enrolled. */
export function insertDisabledAdmin(
  db: IdentityDb,
  account: { username: string; passwordHash: string },
) {
  return db
    .insertInto('tribo.users')
    .values({
      username: account.username,
      password_hash: account.passwordHash,
      platform_role: 'admin',
      status: 'disabled',
    })
    .returning(['id', 'username', 'platform_role', 'status', 'mfa_enabled_at', 'version'])
    .executeTakeFirstOrThrow();
}

/** Enrols TOTP and activates the account in one update, bumping its version. */
export function enrolMfaAndActivate(
  db: IdentityDb,
  userId: string,
  mfaSecretEnc: Buffer,
  expectedVersion: number,
) {
  return db
    .updateTable('tribo.users')
    .set({
      mfa_secret_enc: mfaSecretEnc,
      mfa_enabled_at: sql`now()`,
      status: 'active',
      version: expectedVersion + 1,
      updated_at: sql`now()`,
    })
    .where('id', '=', userId)
    .where('version', '=', expectedVersion)
    .returning(['id', 'username', 'platform_role', 'status', 'mfa_enabled_at', 'version'])
    .executeTakeFirstOrThrow();
}

/**
 * Stores a pending TOTP secret, replacing any earlier pending one, while MFA is still off.
 * A pending secret is credential state: it bumps no version until auth.mfa.confirm enables
 * it. Undefined when the account already has MFA on.
 */
export function setPendingMfaSecret(db: IdentityDb, userId: string, mfaSecretEnc: Buffer) {
  return db
    .updateTable('tribo.users')
    .set({ mfa_secret_enc: mfaSecretEnc })
    .where('id', '=', userId)
    .where('mfa_enabled_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
}

/** The caller's account row, locked for an MFA or password write. */
export function lockAccount(db: IdentityDb, userId: string) {
  return db
    .selectFrom('tribo.users')
    .select(['id', 'version', 'mfa_secret_enc', 'mfa_enabled_at'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
}

/** Enables the pending TOTP secret, bumping the account's version. */
export function enableMfa(
  db: IdentityDb,
  account: { userId: string; expectedVersion: number; by: string | null },
) {
  return db
    .updateTable('tribo.users')
    .set({
      mfa_enabled_at: sql`now()`,
      version: account.expectedVersion + 1,
      updated_at: sql`now()`,
      updated_by: account.by,
    })
    .where('id', '=', account.userId)
    .where('version', '=', account.expectedVersion)
    .returning(['id', 'username', 'platform_role', 'status', 'mfa_enabled_at', 'version'])
    .executeTakeFirstOrThrow();
}

/** The session just proved a second factor. */
export async function markSessionMfaVerified(db: IdentityDb, sessionId: string): Promise<void> {
  await db
    .updateTable('tribo.sessions')
    .set({ mfa_verified_at: sql`now()` })
    .where('id', '=', sessionId)
    .execute();
}

/**
 * Uses a reset link: marks it used if it is live (unused, unrevoked, unexpired, its account
 * not deleted) and returns its account. A concurrent second use waits on the row and finds
 * it used, so a link works exactly once.
 */
export function useResetLink(db: IdentityDb, tokenHash: Buffer) {
  return db
    .updateTable('tribo.password_reset_links as l')
    .from('tribo.users as u')
    .set({ used_at: sql`now()` })
    .whereRef('u.id', '=', 'l.user_id')
    .where('l.token_hash', '=', tokenHash)
    .where('l.used_at', 'is', null)
    .where('l.revoked_at', 'is', null)
    .where('l.expires_at', '>', sql<Date>`now()`)
    .where('u.deleted_at', 'is', null)
    .returning('l.user_id')
    .executeTakeFirst();
}

/** Revokes the account's reset links that are still unused. */
export async function revokeResetLinks(db: IdentityDb, userId: string): Promise<void> {
  await db
    .updateTable('tribo.password_reset_links')
    .set({ revoked_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .where('revoked_at', 'is', null)
    .execute();
}

/**
 * Sets a new password hash and lifts any lockout. The hash is a credential, never in the
 * snapshot, so it bumps no version; the audit event records the act.
 */
export async function setPassword(
  db: IdentityDb,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .updateTable('tribo.users')
    .set({
      password_hash: passwordHash,
      password_changed_at: sql`now()`,
      failed_login_count: 0,
      locked_until: null,
    })
    .where('id', '=', userId)
    .execute();
}

/** Revokes the account's live sessions, all of them or all but `keep`. */
export async function revokeSessions(
  db: IdentityDb,
  userId: string,
  keep: string | null = null,
): Promise<void> {
  let query = db
    .updateTable('tribo.sessions')
    .set({ revoked_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);
  if (keep !== null) query = query.where('id', '<>', keep);
  await query.execute();
}

/** The caller's password hash, with `locked` judged by the database clock. */
export function findPasswordAccount(db: IdentityDb, userId: string) {
  return db
    .selectFrom('tribo.users')
    .select(['id', 'password_hash'])
    .select(sql<boolean>`coalesce(locked_until > now(), false)`.as('locked'))
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}
