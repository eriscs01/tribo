// Mfa schemas: request and response shapes of its operations.
import * as z from 'zod';
import { TotpCode } from './account.js';

/**
 * auth.mfa.setup response: the pending TOTP secret, shown once. Each call replaces the
 * pending secret, so only the latest one confirms.
 */
export const MfaSetup = z
  .strictObject({
    /** The secret in base32, for typing into an authenticator app. */
    key: z.string().regex(/^[A-Z2-7]+$/),
    /** The otpauth:// URI an authenticator app reads from a QR code. */
    uri: z.string().regex(/^otpauth:\/\/totp\//),
  })
  .meta({ id: 'MfaSetup' });

export type MfaSetup = z.infer<typeof MfaSetup>;

/** auth.mfa.confirm body: a code the authenticator app made from the pending secret. */
export const MfaConfirmInput = z.strictObject({ code: TotpCode }).meta({ id: 'MfaConfirmInput' });

export type MfaConfirmInput = z.infer<typeof MfaConfirmInput>;

/**
 * auth.mfa.confirm response. The recovery codes are shown once and never stored for
 * replay: an idempotent replay (1b) omits them and says `redacted: true`.
 */
export const MfaConfirm = z
  .strictObject({
    /** Single-use codes, each accepted once instead of a TOTP code at sign-in. */
    recoveryCodes: z.array(z.string()).optional(),
    redacted: z.boolean(),
  })
  .meta({ id: 'MfaConfirm' });

export type MfaConfirm = z.infer<typeof MfaConfirm>;
