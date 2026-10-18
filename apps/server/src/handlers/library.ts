import { encodeTypeId, ID_PREFIX, MASKED, type Person, type Place } from '@tribo/contract';
import type { LibraryService, PersonRecord, PlaceRecord } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';

export function personView(person: PersonRecord): Person {
  return {
    id: encodeTypeId(ID_PREFIX.person, person.id),
    displayName: person.displayName,
    hasAccount: person.hasAccount,
    contacts: person.contacts,
    dietary: person.dietary,
    drivingLicence: person.drivingLicence,
    emergencyContact: person.hasEmergencyContact ? MASKED : null,
    version: person.version,
    createdAt: person.createdAt.toISOString(),
    updatedAt: person.updatedAt.toISOString(),
  };
}

export function placeView(place: PlaceRecord): Place {
  return {
    ...place,
    id: encodeTypeId(ID_PREFIX.place, place.id),
    createdAt: place.createdAt.toISOString(),
    updatedAt: place.updatedAt.toISOString(),
  };
}

export function libraryHandlers(library: LibraryService): Handlers {
  return {
    'library.people.create': async (request, reply) => {
      const person = await library.createPerson(requestContext(request), request.body);
      return reply.code(201).send(personView(person));
    },

    'library.people.get': async (request) =>
      personView(await library.getPerson(signedIn(request).userId, pathId(request, 'personId'))),

    'library.people.update': async (request) =>
      personView(
        await library.updatePerson(
          requestContext(request),
          pathId(request, 'personId'),
          request.body,
          ifMatch(request),
        ),
      ),

    'library.places.create': async (request, reply) => {
      const place = await library.createPlace(requestContext(request), request.body);
      return reply.code(201).send(placeView(place));
    },
  };
}
