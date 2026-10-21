import { encodeTypeId, ID_PREFIX, PageQuery, type Member, type MemberPage } from '@tribo/contract';
import type { MemberRecord, MembersService } from '@tribo/core';
import { pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';
import { personView } from './library.js';

function memberView(member: MemberRecord): Member {
  return {
    id: encodeTypeId(ID_PREFIX.membership, member.id),
    tripId: encodeTypeId(ID_PREFIX.trip, member.tripId),
    role: member.role,
    canViewCosts: member.canViewCosts,
    person: personView(member.person),
    version: member.version,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

export function membersHandlers(members: MembersService): Handlers {
  return {
    'members.list': async (request): Promise<MemberPage> => {
      const page = await members.list(
        signedIn(request).userId,
        pathId(request, 'tripId'),
        parsedQuery(request, PageQuery),
      );
      return { items: page.items.map(memberView), nextCursor: page.nextCursor };
    },
    'members.add': async (request, reply) => {
      const member = await members.add(
        requestContext(request),
        pathId(request, 'tripId'),
        request.body,
      );
      return reply.code(201).send(memberView(member));
    },
  };
}
