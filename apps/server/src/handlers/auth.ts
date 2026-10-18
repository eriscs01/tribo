import { encodeTypeId, ID_PREFIX, LoginInput, type Session } from '@tribo/contract';
import type { IdentityService, SignedIn } from '@tribo/core';
import { validate } from '@tribo/platform';
import { requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import { clearSessionCookie, csrfTokenFor, sessionTokenOf, setSessionCookie } from '../session.js';

const USER_AGENT_MAX = 512;

/**
 * auth.*: sign-in, session and sign-out over the web session cookie, TOTP enrolment, and
 * the public reset-link password reset.
 */
export function authHandlers(identity: IdentityService, csrfSecret: Buffer): Handlers {
  const view = (session: SignedIn, token: string): Session => ({
    user: {
      id: encodeTypeId(ID_PREFIX.user, session.userId),
      username: session.username,
      platformRole: session.platformRole,
    },
    mfaVerified: session.mfaVerified,
    csrfToken: csrfTokenFor(csrfSecret, token),
    expiresAt: session.expiresAt.toISOString(),
  });

  return {
    'auth.login': async (request, reply) => {
      const input = validate(LoginInput, request.body);
      const { token, session } = await identity.login(requestContext(request), input, {
        ip: request.ip,
        userAgent: request.headers['user-agent']?.slice(0, USER_AGENT_MAX) ?? null,
      });
      const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
      setSessionCookie(reply, token, maxAge);
      return reply.code(201).send(view(session, token));
    },

    'auth.session': (request) =>
      Promise.resolve(view(signedIn(request), sessionTokenOf(request) ?? '')),

    'auth.logout': async (request, reply) => {
      await identity.logout(requestContext(request), sessionTokenOf(request) ?? '');
      clearSessionCookie(reply);
      return reply.code(204).send();
    },
    'auth.mfa.setup': async (request, reply) =>
      reply.code(201).send(await identity.startMfaEnrolment(signedIn(request))),
    // 1a takes no Idempotency-Key here: every confirm runs, none is replayed.
    'auth.mfa.confirm': async (request, reply) =>
      reply
        .code(201)
        .send(await identity.confirmMfa(requestContext(request), signedIn(request), request.body)),
    'auth.passwordReset': async (request, reply) => {
      await identity.resetPassword(requestContext(request), request.body);
      return reply.code(204).send();
    },
  };
}
