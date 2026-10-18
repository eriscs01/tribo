import { encodeTypeId, ID_PREFIX, PageQuery, type Trip, type TripPage } from '@tribo/contract';
import type { TripRecord, TripsService } from '@tribo/core';
import { requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

export function tripView(trip: TripRecord): Trip {
  return {
    id: encodeTypeId(ID_PREFIX.trip, trip.id),
    name: trip.name,
    startDate: trip.startDate,
    endDate: trip.endDate,
    currency: trip.currency,
    timezone: trip.timezone,
    status: trip.status,
    version: trip.version,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

export function tripHandlers(trips: TripsService): Handlers {
  return {
    'trips.list': async (request): Promise<TripPage> => {
      const page = await trips.list(signedIn(request).userId, parsedQuery(request, PageQuery));
      return { items: page.items.map(tripView), nextCursor: page.nextCursor };
    },

    'trips.create': async (request, reply) => {
      const trip = await trips.create(requestContext(request), signedIn(request), request.body);
      return reply.code(201).send(tripView(trip));
    },
  };
}
