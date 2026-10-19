import { encodeTypeId, ID_PREFIX, PageQuery, type Trip, type TripPage } from '@tribo/contract';
import type { TripRecord, TripsService } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
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
    destinations: trip.destinations.map((id) => encodeTypeId(ID_PREFIX.place, id)),
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

    // Sent with its representation ETag: the registry entry declares it.
    'trips.get': async (request): Promise<Trip> =>
      tripView(await trips.get(signedIn(request).userId, pathId(request, 'tripId'))),

    'trips.update': async (request) =>
      tripView(
        await trips.update(
          requestContext(request),
          pathId(request, 'tripId'),
          request.body,
          ifMatch(request),
        ),
      ),

    'trips.delete': async (request, reply) => {
      await trips.delete(
        requestContext(request),
        pathId(request, 'tripId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
  };
}
