import {
  AuthPasswordResetInput,
  MfaConfirmInput,
  NewPassword,
  PasswordChangeInput,
  Username,
  type LoginInput,
  type MfaConfirm,
} from '@tribo/contract';
import { open, seal, type FieldRef, type Keyring } from '@tribo/crypto';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import { ApiError, validate, type RequestContext, type Tx } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent, recordWrite } from '../audit/service.js';
import { createAccountPerson } from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import { writePath } from '../write-path.js';
import {
  burnPasswordCheck,
  hashSecret,
  newRecoveryCode,
  newToken,
  newTotpSecret,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  base32,
  tokenHash,
  totpUri,
  totpValid,
  verifySecret,
} from './credentials.js';
import { countsAsFailure, mfaConfirmRefusal, type LoginStep } from './policy.js';
import * as repo from './repo.js';

type PlatformRole = ValueOf<'tribo.users.platform_role'>;

/** Who a live session belongs to, as authentication resolves it for each request. */
export interface SignedIn {
  sessionId: string;
  userId: string;
  username: string;
  platformRole: PlatformRole;
  mfaVerified: boolean;
  expiresAt: Date;
}

/** Where a sign-in came from; stored on the session row, never in audit. */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface NewAdmin {
  username: string;
  displayName: string;
  password: string;
  /** The secret shown by startTotpEnrolment, and a code the admin's app made from it. */
  totpSecret: Buffer;
  totpCode: string;
}

export interface IdentityService {
  /** Checks credentials, counts failures towards the lockout and opens a session. */
  login(
    ctx: RequestContext,
    input: LoginInput,
    client: ClientInfo,
  ): Promise<{ token: string; session: SignedIn }>;
  /** The live session for a cookie token, sliding its idle expiry; null when there is none. */
  authenticate(token: string): Promise<SignedIn | null>;
  /** Revokes the session; signing out twice is not an error. */
  logout(ctx: RequestContext, token: string): Promise<void>;
  /**
   * `tribo admin create`: the account and its person, inserted disabled, TOTP enrolled,
   * then activated, in one transaction. Returns the recovery codes, shown once.
   */
  createAdmin(
    ctx: RequestContext,
    admin: NewAdmin,
  ): Promise<{ userId: string; personId: string; recoveryCodes: string[] }>;
  /**
   * auth.mfa.setup: a fresh pending TOTP secret for the caller, replacing any earlier one,
   * shown once. invalid_transition once MFA is on (an admin MFA reset turns it off).
   */
  startMfaEnrolment(caller: SignedIn): Promise<{ key: string; uri: string }>;
  /**
   * auth.mfa.confirm: a code from the pending secret turns MFA on, replaces the recovery
   * codes (returned once, never stored for replay) and marks this session MFA-verified.
   */
  confirmMfa(ctx: RequestContext, caller: SignedIn, body: unknown): Promise<MfaConfirm>;
  /**
   * auth.passwordReset: an admin's reset link sets a new password, once. It revokes every
   * session and the account's other reset links, and lifts a lockout. Any link that is not
   * live (used, revoked, expired or unknown) is reset_link_used.
   */
  resetPassword(ctx: RequestContext, body: unknown): Promise<void>;
  /**
   * me.password.change: the current password sets a new one and revokes the caller's other
   * sessions. A wrong current password counts towards the lockout, as at sign-in; while
   * locked, it is rate_limited.
   */
  changePassword(ctx: RequestContext, caller: SignedIn, body: unknown): Promise<void>;
}

const mfaConfirm = writeOperation('auth.mfa.confirm', MfaConfirmInput);

const MFA_SECRET = (userId: string): FieldRef => ({
  table: 'users',
  column: 'mfa_secret_enc',
  rowId: userId,
});

/** A fresh TOTP secret and the otpauth URI (and its key, for typing in) to show the user. */
export function startTotpEnrolment(issuer: string, username: string) {
  const secret = newTotpSecret();
  return { secret, key: base32(secret), uri: totpUri(secret, issuer, username) };
}

export function totpMatches(secret: Buffer, code: string): boolean {
  return totpValid(secret, code);
}

/** `issuer` names this deployment in authenticator apps, e.g. "Tribo (tribo.example)". */
export function createIdentityService(
  db: Kysely<DB>,
  keys: Keyring,
  issuer: string,
): IdentityService {
  const identity = forModule(db, 'identity');
  const write = writePath(db);

  /** Records a refused sign-in (and counts it if it was a guess), then refuses it. */
  async function refuse(
    ctx: RequestContext,
    step: LoginStep,
    userId: string | null,
  ): Promise<never> {
    await db.transaction().execute(async (tx) => {
      if (userId !== null && countsAsFailure(step)) {
        await repo.countFailedLogin(forModule(tx, 'identity'), userId);
      }
      await recordEvent(tx, ctx, {
        action: 'login_failed',
        entityType: 'user',
        entityId: userId,
        tripId: null,
      });
    });
    // One answer for every refusal, so it never tells which accounts exist or are locked.
    throw new ApiError('unauthenticated');
  }

  /** The id of the unused recovery code this matches, if any (Argon2id, so each is checked). */
  async function matchRecoveryCode(userId: string, code: string): Promise<string | null> {
    const typed = normalizeRecoveryCode(code);
    for (const row of await repo.unusedRecoveryCodes(identity, userId)) {
      // eslint-disable-next-line no-await-in-loop -- each Argon2id check is costly; stop at the first match
      if (await verifySecret(row.code_hash, typed)) return row.id;
    }
    return null;
  }

  return {
    async login(ctx, input, client) {
      const account = await repo.findLoginAccount(identity, input.username);
      if (!account) {
        await burnPasswordCheck(input.password);
        return refuse(ctx, 'unknown_user', null);
      }
      if (account.locked) return refuse(ctx, 'locked', account.id);
      if (!(await verifySecret(account.password_hash, input.password))) {
        return refuse(ctx, 'wrong_password', account.id);
      }
      if (account.status !== 'active') return refuse(ctx, 'disabled', account.id);

      let recoveryCodeId: string | null = null;
      if (account.mfa_enabled_at !== null && account.mfa_secret_enc !== null) {
        if (input.totp === undefined && input.recoveryCode === undefined) {
          throw new ApiError('mfa_required');
        }
        if (input.totp !== undefined) {
          const secret = open(keys, MFA_SECRET(account.id), account.mfa_secret_enc);
          if (!totpValid(secret, input.totp)) return refuse(ctx, 'wrong_second_factor', account.id);
        } else {
          recoveryCodeId = await matchRecoveryCode(account.id, input.recoveryCode ?? '');
          if (recoveryCodeId === null) return refuse(ctx, 'wrong_second_factor', account.id);
        }
      }
      const mfaVerified = account.mfa_enabled_at !== null;

      const { token, hash } = newToken();
      const row = await db.transaction().execute(async (tx) => {
        const txIdentity = forModule(tx, 'identity');
        if (recoveryCodeId !== null && !(await repo.useRecoveryCode(txIdentity, recoveryCodeId))) {
          throw new ApiError('unauthenticated'); // the same code was just used elsewhere
        }
        await repo.recordLogin(txIdentity, account.id);
        const session = await repo.insertSession(txIdentity, {
          userId: account.id,
          tokenHash: hash,
          mfaVerified,
          ...client,
        });
        await recordEvent(
          tx,
          { ...ctx, userId: account.id },
          {
            action: 'login',
            entityType: 'user',
            entityId: account.id,
            tripId: null,
          },
        );
        return session;
      });
      return {
        token,
        session: {
          sessionId: row.id,
          userId: account.id,
          username: account.username,
          platformRole: account.platform_role as PlatformRole,
          mfaVerified,
          expiresAt: row.absolute_expires_at,
        },
      };
    },

    async authenticate(token) {
      const row = await repo.touchSession(identity, tokenHash(token));
      if (!row) return null;
      return {
        sessionId: row.sessionId,
        userId: row.userId,
        username: row.username,
        platformRole: row.platform_role as PlatformRole,
        mfaVerified: row.mfa_verified_at !== null,
        expiresAt: row.absolute_expires_at,
      };
    },

    async logout(ctx, token) {
      await db.transaction().execute(async (tx) => {
        const revoked = await repo.revokeSession(forModule(tx, 'identity'), tokenHash(token));
        if (!revoked) return;
        await recordEvent(
          tx,
          { ...ctx, userId: revoked.user_id },
          {
            action: 'logout',
            entityType: 'user',
            entityId: revoked.user_id,
            tripId: null,
          },
        );
      });
    },

    async createAdmin(ctx, admin) {
      const username = validate(Username, admin.username);
      const password = validate(NewPassword, admin.password);
      if (!totpValid(admin.totpSecret, admin.totpCode)) {
        throw new ApiError('validation_failed', {
          errors: [{ path: '/totpCode', message: 'code does not match the secret' }],
        });
      }
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      const [passwordHash, ...codeHashes] = await Promise.all(
        [password, ...recoveryCodes].map(hashSecret),
      );

      return db.transaction().execute(async (tx) => {
        const txIdentity = forModule(tx, 'identity');
        const created = await insertAdmin(tx, username, passwordHash ?? '');
        await recordWrite(tx, ctx, {
          action: 'create',
          aggregate: 'user',
          entityId: created.id,
          tripId: null,
          version: created.version,
          versionBefore: null,
          snapshot: userSnapshot(created),
        });

        const { result: person, ...personChange } = await createAccountPerson(tx, {
          userId: created.id,
          displayName: admin.displayName,
        });
        await recordWrite(tx, ctx, { ...personChange, versionBefore: null });

        const secretEnc = seal(keys, MFA_SECRET(created.id), admin.totpSecret);
        const active = await repo.enrolMfaAndActivate(
          txIdentity,
          created.id,
          secretEnc,
          created.version,
        );
        await repo.replaceRecoveryCodes(txIdentity, created.id, codeHashes);
        await recordWrite(tx, ctx, {
          action: 'mfa_enrol',
          aggregate: 'user',
          entityId: created.id,
          tripId: null,
          version: active.version,
          versionBefore: created.version,
          snapshot: userSnapshot(active),
        });
        return { userId: created.id, personId: person.personId, recoveryCodes };
      });
    },

    async startMfaEnrolment(caller) {
      const enrolment = startTotpEnrolment(issuer, caller.username);
      const secretEnc = seal(keys, MFA_SECRET(caller.userId), enrolment.secret);
      if (!(await repo.setPendingMfaSecret(identity, caller.userId, secretEnc))) {
        throw new ApiError('invalid_transition', { detail: 'MFA is already on' });
      }
      return { key: enrolment.key, uri: enrolment.uri };
    },

    confirmMfa: (ctx, caller, body) =>
      write(ctx, {
        operation: mfaConfirm,
        target: caller,
        body,
        ifMatch: undefined,
        // Self only: the target is the caller's own account, so there is nobody else to refuse.
        authorize: () => Promise.resolve(),
        load: async (tx, target) => {
          const account = await repo.lockAccount(forModule(tx, 'identity'), target.userId);
          if (!account) throw new ApiError('not_found');
          return { tripId: null, counter: account.version, account };
        },
        mutate: async (tx, c, { account }, input) => {
          const refusal = mfaConfirmRefusal({
            mfaEnabled: account.mfa_enabled_at !== null,
            hasPendingSecret: account.mfa_secret_enc !== null,
          });
          if (refusal) throw new ApiError(refusal);
          const secret = open(
            keys,
            MFA_SECRET(account.id),
            account.mfa_secret_enc ?? Buffer.alloc(0),
          );
          if (!totpValid(secret, input.code)) {
            throw new ApiError('validation_failed', {
              errors: [{ path: '/code', message: 'code does not match the pending secret' }],
            });
          }
          const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
          const codeHashes = await Promise.all(recoveryCodes.map(hashSecret));

          const txIdentity = forModule(tx, 'identity');
          const enabled = await repo.enableMfa(txIdentity, {
            userId: account.id,
            expectedVersion: account.version,
            by: c.userId,
          });
          await repo.replaceRecoveryCodes(txIdentity, account.id, codeHashes);
          await repo.markSessionMfaVerified(txIdentity, caller.sessionId);
          return {
            action: 'mfa_enrol',
            aggregate: 'user',
            entityId: account.id,
            tripId: null,
            version: enabled.version,
            snapshot: userSnapshot(enabled),
            result: { recoveryCodes, redacted: false },
          };
        },
      }),

    async resetPassword(ctx, body) {
      const input = validate(AuthPasswordResetInput, body);
      const passwordHash = await hashSecret(input.newPassword);
      await db.transaction().execute(async (tx) => {
        const txIdentity = forModule(tx, 'identity');
        const link = await repo.useResetLink(txIdentity, tokenHash(input.token));
        if (!link) throw new ApiError('reset_link_used');
        await repo.setPassword(txIdentity, link.user_id, passwordHash);
        await repo.revokeSessions(txIdentity, link.user_id);
        await repo.revokeResetLinks(txIdentity, link.user_id);
        await recordEvent(
          tx,
          { ...ctx, userId: link.user_id },
          { action: 'password_reset', entityType: 'user', entityId: link.user_id, tripId: null },
        );
      });
    },

    async changePassword(ctx, caller, body) {
      const input = validate(PasswordChangeInput, body);
      const account = await repo.findPasswordAccount(identity, caller.userId);
      if (!account) throw new ApiError('unauthenticated');
      if (account.locked) throw new ApiError('rate_limited');
      if (!(await verifySecret(account.password_hash, input.currentPassword))) {
        await repo.countFailedLogin(identity, account.id);
        throw new ApiError('validation_failed', {
          errors: [{ path: '/currentPassword', message: 'does not match the current password' }],
        });
      }
      const passwordHash = await hashSecret(input.newPassword);
      await db.transaction().execute(async (tx) => {
        const txIdentity = forModule(tx, 'identity');
        await repo.setPassword(txIdentity, account.id, passwordHash);
        await repo.revokeSessions(txIdentity, account.id, caller.sessionId);
        await recordEvent(tx, ctx, {
          action: 'password_change',
          entityType: 'user',
          entityId: account.id,
          tripId: null,
        });
      });
    },
  };
}

/** Two concurrent creates of one username: the unique index decides, as username_taken. */
async function insertAdmin(tx: Tx, username: string, passwordHash: string) {
  try {
    return await repo.insertDisabledAdmin(forModule(tx, 'identity'), { username, passwordHash });
  } catch (error) {
    if (
      error instanceof Error &&
      'constraint' in error &&
      error.constraint === 'users_username_key'
    ) {
      throw new ApiError('username_taken');
    }
    throw error;
  }
}

/** What history shows of an account: never a hash, a secret or login bookkeeping. */
function userSnapshot(row: {
  username: string;
  platform_role: string;
  status: string;
  mfa_enabled_at: Date | null;
}) {
  return {
    username: row.username,
    platformRole: row.platform_role,
    status: row.status,
    mfaEnabled: row.mfa_enabled_at !== null,
  };
}
