import { encodeTypeId, ID_PREFIX, type Overlay } from '@tribo/contract';
import type { OverlaysService, OverlayRecord } from '@tribo/core';
import { createOnly, ifMatch, pathId, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';

/** Names ids and times as the API does; an overlay is the caller's own, so nothing is masked. */
function overlayView(overlay: OverlayRecord): Overlay {
  return {
    itemId: encodeTypeId(ID_PREFIX.item, overlay.itemId),
    tripId: encodeTypeId(ID_PREFIX.trip, overlay.tripId),
    note: overlay.note,
    reminderAt: overlay.reminderAt === null ? null : overlay.reminderAt.toISOString(),
    checklist: overlay.checklist,
    version: overlay.version,
    createdAt: overlay.createdAt.toISOString(),
    updatedAt: overlay.updatedAt.toISOString(),
  };
}

export function overlayHandlers(overlays: OverlaysService): Handlers {
  return {
    // Private to the caller's membership, so never kept by a shared cache.
    'overlays.get': async (request, reply) => {
      const overlay = await overlays.get(signedIn(request).userId, pathId(request, 'itemId'));
      return reply.header('cache-control', 'private, no-store').send(overlayView(overlay));
    },

    // The caller's own overlay answers 200 whether it was created or replaced; its version says which.
    'overlays.put': async (request, reply) => {
      const precondition = { ifMatch: ifMatch(request), createOnly: createOnly(request) };
      const overlay = await overlays.put(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
        precondition,
      );
      return reply.header('cache-control', 'private, no-store').send(overlayView(overlay));
    },

    'overlays.delete': async (request, reply) => {
      await overlays.delete(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
  };
}
