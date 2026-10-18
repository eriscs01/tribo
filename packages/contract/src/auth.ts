// Auth schemas: request and response shapes of its operations.
import * as z from 'zod';
import { NewPassword } from './account.js';

/**
 * auth.passwordReset body. The token comes from the admin's reset link and travels in the
 * body, never the URL; any token that is not a live link fails the same way.
 */
export const AuthPasswordResetInput = z
  .strictObject({
    token: z.string().min(1).max(128),
    newPassword: NewPassword,
  })
  .meta({ id: 'AuthPasswordResetInput' });

export type AuthPasswordResetInput = z.infer<typeof AuthPasswordResetInput>;
