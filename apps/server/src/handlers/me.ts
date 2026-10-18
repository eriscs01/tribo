import type { IdentityService } from '@tribo/core';
import { requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';

/** me.* : the caller's own account. */
export function meHandlers(identity: IdentityService): Handlers {
  return {
    'me.password.change': async (request, reply) => {
      await identity.changePassword(requestContext(request), signedIn(request), request.body);
      return reply.code(204).send();
    },
  };
}
