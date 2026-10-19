import {
  encodeTypeId,
  ID_PREFIX,
  ItemListQuery,
  MASKED,
  type Item,
  type ItemPage,
  type ItemRsvp,
  type ItemTime,
} from '@tribo/contract';
import type { ItemRecord, ItemsService, ItemTimeRecord } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

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
    cost: item.cost === 'masked' ? MASKED : item.cost,
    bookingRef: item.hasBookingRef ? MASKED : null,
    cardLast4: item.hasCardLast4 ? MASKED : null,
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
    'items.list': async (request): Promise<ItemPage> => {
      const page = await items.list(
        signedIn(request).userId,
        pathId(request, 'tripId'),
        parsedQuery(request, ItemListQuery),
      );
      return { items: page.items.map(itemView), nextCursor: page.nextCursor };
    },

    'items.update': async (request) =>
      itemView(
        await items.update(
          requestContext(request),
          pathId(request, 'itemId'),
          request.body,
          ifMatch(request),
        ),
      ),
    'items.delete': async (request, reply) => {
      await items.delete(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
    'items.rsvp': async (request): Promise<ItemRsvp> => {
      const answer = await items.rsvp(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
      );
      return {
        itemId: encodeTypeId(ID_PREFIX.item, answer.itemId),
        membershipId: encodeTypeId(ID_PREFIX.membership, answer.membershipId),
        rsvp: answer.rsvp,
        boardVersion: answer.boardVersion,
      };
    },
  };
}
