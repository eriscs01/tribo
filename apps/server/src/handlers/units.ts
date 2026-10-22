import {
  encodeTypeId,
  ID_PREFIX,
  MASKED,
  PageQuery,
  type ItemBoard,
  type Unit,
  type UnitPage,
} from '@tribo/contract';
import type { BoardRecord, UnitRecord, UnitsService } from '@tribo/core';
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

function boardView(board: BoardRecord): ItemBoard {
  const unit = (id: string) => encodeTypeId(ID_PREFIX.unit, id);
  return {
    itemId: encodeTypeId(ID_PREFIX.item, board.itemId),
    boardVersion: board.boardVersion,
    allocations: board.allocations.map((a) => ({
      membershipId: encodeTypeId(ID_PREFIX.membership, a.membershipId),
      role: a.role,
      unitId: a.unitId === null ? null : unit(a.unitId),
      rsvp: a.rsvp,
    })),
    warnings: board.warnings.map((w) => ({ code: w.code, unitId: unit(w.unitId) })),
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
    'units.delete': async (request, reply) => {
      await units.delete(
        requestContext(request),
        pathId(request, 'unitId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
    // The ETag covers the whole body; a client reads boardVersion from it for If-Match.
    'items.assignments.get': async (request) =>
      boardView(await units.board(signedIn(request).userId, pathId(request, 'itemId'))),
    'items.assignments.replace': async (request) =>
      boardView(
        await units.replaceBoard(
          requestContext(request),
          pathId(request, 'itemId'),
          request.body,
          ifMatch(request),
        ),
      ),
  };
}
