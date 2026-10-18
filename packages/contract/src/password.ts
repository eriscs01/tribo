// Password schemas: request and response shapes of its operations.
import * as z from 'zod';
import { NewPassword } from './account.js';

/** me.password.change body: the current password proves it is the account holder. */
export const PasswordChangeInput = z
  .strictObject({
    currentPassword: z.string().min(1).max(128),
    newPassword: NewPassword,
  })
  .meta({ id: 'PasswordChangeInput' });

export type PasswordChangeInput = z.infer<typeof PasswordChangeInput>;
