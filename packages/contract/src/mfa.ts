// Mfa schemas: request and response shapes of its operations.
import * as z from 'zod';

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
