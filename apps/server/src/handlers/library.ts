import {
  encodeTypeId,
  ID_PREFIX,
  LibrarySearchQuery,
  MASKED,
  type LibraryHit,
  type Person,
  type Place,
  type Vendor,
} from '@tribo/contract';
import type {
  LibraryHitRecord,
  LibraryService,
  PersonRecord,
  PlaceRecord,
  VendorRecord,
} from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

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

function placeView(place: PlaceRecord): Place {
  return {
    ...place,
    id: encodeTypeId(ID_PREFIX.place, place.id),
    createdAt: place.createdAt.toISOString(),
    updatedAt: place.updatedAt.toISOString(),
  };
}

function vendorView(vendor: VendorRecord): Vendor {
  return {
    ...vendor,
    id: encodeTypeId(ID_PREFIX.vendor, vendor.id),
    placeId: vendor.placeId === null ? null : encodeTypeId(ID_PREFIX.place, vendor.placeId),
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  };
}

function hitView(hit: LibraryHitRecord): LibraryHit {
  switch (hit.kind) {
    case 'person':
      return { ...hit, id: encodeTypeId(ID_PREFIX.person, hit.id) };
    case 'place':
      return { ...hit, id: encodeTypeId(ID_PREFIX.place, hit.id) };
    case 'vendor':
      return { ...hit, id: encodeTypeId(ID_PREFIX.vendor, hit.id) };
    default: {
      const unhandled: never = hit;
      throw new Error(`library hit ${JSON.stringify(unhandled)} has no view`);
    }
  }
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

    'library.vendors.create': async (request, reply) => {
      const vendor = await library.createVendor(requestContext(request), request.body);
      return reply.code(201).send(vendorView(vendor));
    },
    'library.search': async (request) => {
      const hits = await library.search(
        signedIn(request).userId,
        parsedQuery(request, LibrarySearchQuery),
      );
      return { items: hits.map(hitView) };
    },
  };
}
