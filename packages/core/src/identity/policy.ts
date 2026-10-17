/** Lockout in the app: this many failed sign-ins in a row lock the username… */
export const MAX_FAILED_LOGINS = 5;
/** …for this long. The count restarts once the lock is set. */
export const LOCKOUT_MINUTES = 15;

/** Why a sign-in attempt stopped, in the order the checks run. */
export type LoginStep =
  | 'unknown_user'
  | 'locked'
  | 'wrong_password'
  | 'disabled'
  | 'mfa_required'
  | 'wrong_second_factor';

/**
 * Whether a failed step counts towards the lockout. Only guesses count: a wrong password or
 * a wrong second factor. A locked account is refused before anything is checked, and
 * `disabled` and `mfa_required` are reached only with the right password.
 */
export function countsAsFailure(step: LoginStep): boolean {
  return step === 'wrong_password' || step === 'wrong_second_factor';
}
