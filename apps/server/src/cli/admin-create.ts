import { NewPassword, Username } from '@tribo/contract';
import { startTotpEnrolment, totpMatches, type IdentityService } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { CliError, type CliIo } from './io.js';

const TOTP_ATTEMPTS = 3;

/**
 * `tribo admin create <username> [display name]`: the first platform admin (or another one,
 * from the host). Asks for a password, shows a TOTP secret to enrol, checks a code from the
 * app, then creates the account active, with MFA, and prints its recovery codes once.
 * The format checks here are for the operator's convenience; createAdmin decides.
 */
export async function adminCreate(
  deps: { identity: IdentityService; io: CliIo; issuer: string; ctx: RequestContext },
  args: readonly string[],
): Promise<void> {
  const { io } = deps;
  const [username, ...name] = args;
  if (username === undefined)
    throw new CliError('usage: tribo admin create <username> [display name]');
  if (!Username.safeParse(username).success) {
    throw new CliError('username: 3–32 letters, digits, dot, dash or underscore');
  }

  const password = await io.ask('Password (12–128 characters): ', { secret: true });
  if (!NewPassword.safeParse(password).success)
    throw new CliError('password must be 12–128 characters');
  if ((await io.ask('Repeat password: ', { secret: true })) !== password) {
    throw new CliError('passwords do not match');
  }

  const enrolment = startTotpEnrolment(deps.issuer, username);
  io.say('');
  io.say('Add this account to your authenticator app (paste the URI or type the key):');
  io.say(`  ${enrolment.uri}`);
  io.say(`  key: ${enrolment.key}`);
  let code: string | undefined;
  for (let attempt = 1; attempt <= TOTP_ATTEMPTS && code === undefined; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- one prompt at a time, until a code matches
    const typed = (await io.ask('Six-digit code from the app: ')).trim();
    if (totpMatches(enrolment.secret, typed)) code = typed;
    else io.say('That code does not match; check the app and the host clock.');
  }
  if (code === undefined) throw new CliError('TOTP not confirmed; nothing was created');

  try {
    const { recoveryCodes } = await deps.identity.createAdmin(deps.ctx, {
      username,
      displayName: name.length > 0 ? name.join(' ') : username,
      password,
      totpSecret: enrolment.secret,
      totpCode: code,
    });
    io.say('');
    io.say(
      `Admin ${username} created, with MFA. Recovery codes (each works once; shown only now):`,
    );
    for (const recovery of recoveryCodes) io.say(`  ${recovery}`);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === 'username_taken') throw new CliError(`username ${username} is taken`);
    const details = error.extra.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new CliError(`${error.code}${details ? ` (${details})` : ''}`);
  }
}
