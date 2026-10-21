import {
  encodeTypeId,
  ID_PREFIX,
  MASKED,
  PageQuery,
  type Unit,
  type UnitPage,
} from '@tribo/contract';
import type { UnitRecord, UnitsService } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

function unitView(unit: UnitRecord): Unit {
  return {
    id: encodeTypeId(ID_PREFIX.unit, unit.id),
    itemId: encodeTypeId(ID_PREFIX.item, unit.itemId),
    kind: unit.kind,
    label: unit.label,
    capacity: unit.capacity,
    bedType: unit.bedType,
    rate: unit.rate === 'masked' ? MASKED : unit.rate,
    position: unit.position,
    version: unit.version,
    createdAt: unit.createdAt.toISOString(),
    updatedAt: unit.updatedAt.toISOString(),
  };
}

export function unitsHandlers(units: UnitsService): Handlers {
  return {
    'units.list': async (request): Promise<UnitPage> => {
      const page = await units.list(
        signedIn(request).userId,
        pathId(request, 'itemId'),
        parsedQuery(request, PageQuery),
      );
      return { items: page.items.map(unitView), nextCursor: page.nextCursor };
    },
    'units.create': async (request, reply) => {
      const unit = await units.create(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
      );
      return reply.code(201).send(unitView(unit));
    },
    'units.update': async (request) =>
      unitView(
        await units.update(
          requestContext(request),
          pathId(request, 'unitId'),
          request.body,
          ifMatch(request),
        ),
      ),
  };
}
