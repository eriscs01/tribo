import {
  encodeTypeId,
  ID_PREFIX,
  PageQuery,
  type Invite,
  type InviteCreated,
  type InvitePage,
} from '@tribo/contract';
import type { InviteRecord, InvitesService } from '@tribo/core';
import { pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

function inviteView(invite: InviteRecord): Invite {
  return {
    id: encodeTypeId(ID_PREFIX.invite, invite.id),
    tripId: encodeTypeId(ID_PREFIX.trip, invite.tripId),
    role: invite.role,
    personId: invite.personId === null ? null : encodeTypeId(ID_PREFIX.person, invite.personId),
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
    uses: invite.uses,
    status: invite.status,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}

/** invites.*: the owner's invite links, and the public preview and join behind them. */
export function invitesHandlers(invites: InvitesService): Handlers {
  return {
    'invites.list': async (request): Promise<InvitePage> => {
      const page = await invites.list(
        signedIn(request).userId,
        pathId(request, 'tripId'),
        parsedQuery(request, PageQuery),
      );
      return { items: page.items.map(inviteView), nextCursor: page.nextCursor };
    },
    // 1a takes no Idempotency-Key here: every create makes a new link, none is replayed.
    'invites.create': async (request, reply) => {
      const { token, link, redacted, ...invite } = await invites.create(
        requestContext(request),
        pathId(request, 'tripId'),
        request.body,
      );
      const created: InviteCreated = { ...inviteView(invite), token, link, redacted };
      return reply.code(201).send(created);
    },
    'invites.revoke': async (request) =>
      inviteView(
        await invites.revoke(
          requestContext(request),
          pathId(request, 'tripId'),
          pathId(request, 'inviteId'),
          request.body,
        ),
      ),
  };
}
