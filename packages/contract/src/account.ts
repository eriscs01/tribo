import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { Instant } from './time.js';

/** Unique and case-insensitive; the tribo.username domain stores the same rule. */
export const Username = z
  .string()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, '3–32 letters, digits, dot, dash or underscore')
  .meta({ id: 'Username' });

/** Length rules only (NIST SP 800-63B): no composition rules, no maximum below 128. */
export const NewPassword = z.string().min(12).max(128).meta({ id: 'NewPassword' });

/** A six-digit code from the authenticator app. */
export const TotpCode = z
  .string()
  .regex(/^\d{6}$/, 'six digits')
  .meta({ id: 'TotpCode' });

/**
 * auth.login. A username in any shape is accepted here: a malformed one fails the same
 * way as a wrong password, so the response never says which accounts exist.
 */
export const LoginInput = z
  .strictObject({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
    /** Needed once the account has MFA; or a recovery code instead. */
    totp: TotpCode.optional(),
    recoveryCode: z.string().min(1).max(32).optional(),
  })
  .refine((v) => v.totp === undefined || v.recoveryCode === undefined, {
    message: 'send a TOTP code or a recovery code, not both',
    path: ['recoveryCode'],
  })
  .meta({ id: 'LoginInput' });

export type LoginInput = z.infer<typeof LoginInput>;

/** The signed-in session, as auth.login and auth.session return it. */
export const Session = z
  .strictObject({
    user: z.strictObject({
      id: typeId(ID_PREFIX.user),
      username: Username,
      platformRole: z.enum(['admin', 'user']),
    }),
    /** True when this sign-in passed TOTP or a recovery code. */
    mfaVerified: z.boolean(),
    /** Send as X-CSRF-Token on every unsafe request. */
    csrfToken: z.string(),
    /** The session's absolute expiry; idle sessions end sooner. */
    expiresAt: Instant,
  })
  .meta({ id: 'Session' });

export type Session = z.infer<typeof Session>;
