import { LoginInput } from '@tribo/contract';
import type { IdentityService } from '@tribo/core';
import { validate } from '@tribo/platform';
import { requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import {
  clearSessionCookie,
  clientOf,
  cookieMaxAge,
  sessionTokenOf,
  sessionView,
  setSessionCookie,
} from '../session.js';

/**
 * auth.*: sign-in, session and sign-out over the web session cookie, TOTP enrolment, and
 * the public reset-link password reset.
 */
export function authHandlers(identity: IdentityService, csrfSecret: Buffer): Handlers {
  return {
    'auth.login': async (request, reply) => {
      const input = validate(LoginInput, request.body);
      const { token, session } = await identity.login(
        requestContext(request),
        input,
        clientOf(request),
      );
      setSessionCookie(reply, token, cookieMaxAge(session));
      return reply.code(201).send(sessionView(csrfSecret, session, token));
    },

    'auth.session': (request) =>
      Promise.resolve(sessionView(csrfSecret, signedIn(request), sessionTokenOf(request) ?? '')),

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
