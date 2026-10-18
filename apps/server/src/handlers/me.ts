import { encodeTypeId, ID_PREFIX, type Me } from '@tribo/contract';
import type { IdentityService, LibraryService, PersonRecord, SignedIn } from '@tribo/core';
import { ifMatch, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import { personView } from './library.js';

/** The account comes from the session identity resolved; the person from the library. */
function meView(caller: SignedIn, person: PersonRecord): Me {
  return {
    account: {
      id: encodeTypeId(ID_PREFIX.user, caller.userId),
      username: caller.username,
      platformRole: caller.platformRole,
    },
    person: personView(person),
  };
}

/** me.* : the caller's own account (identity) and own person (library). */
export function meHandlers(identity: IdentityService, library: LibraryService): Handlers {
  return {
    'me.get': async (request) => {
      const caller = signedIn(request);
      return meView(caller, await library.ownPerson(caller.userId));
    },

    'me.update': async (request) =>
      meView(
        signedIn(request),
        await library.updateOwnPerson(requestContext(request), request.body, ifMatch(request)),
      ),

    'me.password.change': async (request, reply) => {
      await identity.changePassword(requestContext(request), signedIn(request), request.body);
      return reply.code(204).send();
    },
  };
}
