import { encodeTypeId, ID_PREFIX, type Me, type MyTasks } from '@tribo/contract';
import type {
  IdentityService,
  LibraryService,
  MyTasksRecord,
  MyTasksService,
  PersonRecord,
  SignedIn,
} from '@tribo/core';
import { ifMatch, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import { dueSoonView } from './dashboard.js';
import { itemView } from './items.js';
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

function myTasksView(mine: MyTasksRecord): MyTasks {
  return {
    tasks: mine.tasks.map((t) => ({ tripName: t.tripName, item: itemView(t.item) })),
    dueSoon: mine.dueSoon.map(dueSoonView),
  };
}

/** me.* : the caller's own account (identity), own person (library) and own tasks (itinerary). */
export function meHandlers(
  identity: IdentityService,
  library: LibraryService,
  myTasks: MyTasksService,
): Handlers {
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

    'me.tasks': async (request): Promise<MyTasks> =>
      myTasksView(await myTasks.get(signedIn(request).userId)),

    'me.password.change': async (request, reply) => {
      await identity.changePassword(requestContext(request), signedIn(request), request.body);
      return reply.code(204).send();
    },
  };
}
