import { encodeTypeId, ID_PREFIX, type Item, type ItemTime } from '@tribo/contract';
import type { ItemRecord, ItemsService, ItemTimeRecord } from '@tribo/core';
import { pathId, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';

function timeView(time: ItemTimeRecord | null): ItemTime | null {
  if (time === null) return null;
  return 'date' in time
    ? { date: time.date }
    : { local: time.local, tz: time.tz, at: time.at.toISOString() };
}

export function itemView(item: ItemRecord): Item {
  return {
    id: encodeTypeId(ID_PREFIX.item, item.id),
    tripId: encodeTypeId(ID_PREFIX.trip, item.tripId),
    type: item.type,
    title: item.title,
    status: item.status,
    start: timeView(item.start),
    end: timeView(item.end),
    visibility: item.visibility,
    ownerMembershipId: encodeTypeId(ID_PREFIX.membership, item.ownerMembershipId),
    tags: item.tags,
    version: item.version,
    boardVersion: item.boardVersion,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function itemHandlers(items: ItemsService): Handlers {
  return {
    'items.create': async (request, reply) => {
      const item = await items.create(
        requestContext(request),
        pathId(request, 'tripId'),
        request.body,
      );
      return reply.code(201).send(itemView(item));
    },

    'items.get': async (request) =>
      itemView(await items.get(signedIn(request).userId, pathId(request, 'itemId'))),
  };
}
